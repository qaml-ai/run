// Real-tier mode (CAMELFS_CONTRACT_URL/KEY) is only for a tier you start
// yourself, locally or on a Sprite, with DynamoDB Local and a throwaway test
// key. Never target production or staging. Their JWKS trusts only the runtime's real signer.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { TokenClaims } from "../../backends/workers/test/camelfs-token.ts";

type Target = {
  url: string;
  issuer: string;
  mint(claims: TokenClaims, header?: Record<string, unknown>): string;
  now?: () => number;
  advance?: (ms: number) => void;
  interceptWrite?: (hook: () => Promise<void>) => void;
  seedHistory?: (lineage: string, tree: string, parent: string, length: number) => Promise<string>;
};
type Ref = { name: string; version: string; tree: string; owner: string; createdBy: string; holder?: typeof holder; leaseEpoch: number };
type Commit = { commit: string; tree: string; parents: string[] };
type Lease = { epoch: number; deadline: number; version: string; tree: string };
type Moved = { version: string; tree: string; bytes: number; files: number; parents: string[]; changed: unknown[]; diff: unknown[]; ff?: boolean };
const holder = { host: "host-contract", boot: 1, mount: "mount-contract" };
const actor = "runtime:refs-contract", owner = "agent:contract", unknown = "f".repeat(40);
const refPath = (name: string) => "/refs/" + encodeURIComponent(name);
const meta = (message: string) => ({ author: owner, time: 1763046000, message, trailers: {} });

function client(target: Target) {
  const lin = "contract:" + randomUUID();
  const now = target.now ?? Date.now;
  const claims = (): TokenClaims => {
    const iat = Math.floor(now() / 1000);
    return { iss: target.issuer, aud: "camelrun:camelfs", sub: actor, lin, acc: "w", refs: ["main", "other", "work", "pub/*"],
      iat, exp: iat + 120 };
  };
  async function request<T>(method: string, path: string, status: number | number[], body?: unknown, opts: {
    claims?: TokenClaims; key?: string; token?: string | null; header?: Record<string, unknown>; code?: string; raw?: boolean;
  } = {}): Promise<T> {
    const token = opts.token === undefined ? target.mint({ ...claims(), ...opts.claims }, opts.header) : opts.token;
    const response = await fetch(target.url.replace(/\/$/, "") + "/v1/lineages/" + encodeURIComponent(lin) + path, {
      method, signal: AbortSignal.timeout(10_000),
      headers: { ...(token === null ? {} : { authorization: "Bearer " + token }),
        ...(opts.key ? { "Idempotency-Key": opts.key } : {}),
        ...(body === undefined ? {} : { "Content-Type": opts.raw ? "application/octet-stream" : "application/json" }) },
      ...(body === undefined ? {} : { body: opts.raw ? body as string : JSON.stringify(body) }),
    });
    const text = await response.text();
    if (Array.isArray(status)) assert.ok(status.includes(response.status), `${method} ${path}: ${response.status} ${text}`);
    else assert.equal(response.status, status, `${method} ${path}: ${text}`);
    const value = text ? JSON.parse(text) : undefined;
    if (opts.code) assert.equal(value?.error?.code, opts.code, `${method} ${path}: ${text}`);
    return value as T;
  }
  const lineage = { tenant: "contract", kind: "workspace", defaultBranch: "main" };
  const put = () => request("PUT", "", 201, lineage);
  const create = (version: string, name = "main", extra = {}) => request<Ref>("POST", "/refs", 201, { version, name, owner, ...extra });
  const get = (name = "main") => request<Ref>("GET", refPath(name), 200);
  const list = (query = "") => request<{ refs: Ref[]; next?: string }>("GET", "/refs" + query, 200);
  const commit = (parents: string[], changes: unknown[] = [], message = "object") =>
    request<Commit>("POST", "/commits", 201, { ...meta(message), parents, changes });
  const blob = (text: string) => request<{ blob: string; size: number }>("PUT", "/blobs", 201, text, { raw: true });
  const seed = async () => { await put(); const base = await commit([]); await create(base.commit); return base; };
  const cas = (expect: string, version: string, extra = {}, opts = {}) =>
    request<Moved>("POST", "/refs/main/cas", 200, { expect, commit: version, ...extra }, opts);
  const write = (changes: unknown[], extra = {}, opts = {}) =>
    request<Moved>("POST", "/refs/main/write", 201, { ...meta("write"), changes, ...extra }, opts);
  const acquire = (ttlMs = 60_000, name = "main") =>
    request<Lease>("POST", refPath(name) + "/lease", 200, { holder, ttlMs });
  // The fence claim carries the holder as its canonical string <host>:<boot>:<mount>; bodies carry the object.
  const fenced = (epoch: number, who = holder, name = "main") => ({ claims: { refs: [name], fence: { holder: `${who.host}:${who.boot}:${who.mount}`, epoch } } });
  const release = (epoch: number, name = "main") => request("DELETE", refPath(name) + "/lease", 204, undefined, fenced(epoch, holder, name));
  const fail = (method: string, path: string, status: number, code: string, body?: unknown, opts = {}) =>
    request<{ error: { details?: unknown; message: string } }>(method, path, status, body, { ...opts, code });
  const until = async (deadline: number) => {
    if (target.advance) target.advance(Math.max(0, deadline - now()));
    else {
      const remaining = Math.max(0, deadline - Date.now() + 150);
      assert.ok(remaining <= 6_000, "unexpected tier deadline or clock skew");
      await delay(remaining);
    }
  };
  return { lin, request, put, lineage, seed, create, get, list, commit, blob, cas, write, acquire, fenced, release, fail, claims, now, until };
}

export async function runCamelfsRefsCases(t: TestContext, target: Target) {
  const run = (name: string, check: (c: ReturnType<typeof client>) => Promise<void>) =>
    t.test(name, () => check(client(target)));

  await run("lineage PUT and GET, ref create/read/pagination and strict name/owner rules", async c => {
    const base = await c.seed();
    await c.request("PUT", "", 200, c.lineage);
    const conflict = await c.fail("PUT", "", 409, "lineage_conflict", { ...c.lineage, tenant: "another" });
    assert.deepEqual(conflict.error.details, { tenant: c.lineage.tenant });
    const item = await c.request<typeof c.lineage>("GET", "", 200);
    for (const key of Object.keys(c.lineage) as (keyof typeof item)[]) assert.equal(item[key], c.lineage[key]);
    await c.create(base.commit, "pub/a");
    await c.create(base.commit, "pub/b");
    const page = await c.list("?prefix=pub%2F&limit=1");
    assert.deepEqual(page.refs.map(r => r.name), ["pub/a"]);
    assert.equal(page.next, "pub/a");
    assert.deepEqual((await c.list("?prefix=pub%2F&after=pub%2Fa")).refs.map(r => r.name), ["pub/b"]);
    assert.equal((await c.get("pub/b")).version, base.commit);
    await c.fail("POST", "/refs", 409, "ref_exists", { name: "main", owner, version: base.commit });
    for (const name of ["pub//a", "pub/../a", "pub/.", "pub/a.lock/b", "pub/@a", "x".repeat(201)]) {
      await c.fail("POST", "/refs", 400, "invalid_request", { name, owner, version: base.commit });
    }
    await c.fail("POST", "/refs", 400, "invalid_request", { name: "other", owner: "other:x", version: base.commit });
    await c.fail("POST", "/refs", 400, "unknown_commit", { name: "other", owner, version: unknown });
  });

  await run("1. held API moves and deletes, and mismatched token fences", async c => {
    const base = await c.seed();
    const lease = await c.acquire();
    await c.fail("POST", "/refs/main/write", 409, "held", { ...meta("write"), changes: [] });
    await c.fail("POST", "/refs/main/merge", 409, "held", { ...meta("merge"), theirs: base.commit, mode: "merge" });
    await c.fail("POST", "/refs/main/restore", 409, "held", { ...meta("restore"), version: base.commit });
    await c.fail("DELETE", "/refs/main?expect=" + unknown, 409, "held");
    await c.fail("DELETE", "/refs/main", 409, "held");
    const cas = { commit: base.commit, expect: base.commit };
    await c.fail("POST", "/refs/main/cas", 409, "fenced", cas);
    const wrong = c.fenced(lease.epoch + 1);
    await c.fail("POST", "/refs/main/cas", 409, "fenced", cas, wrong);
    await c.fail("POST", "/refs/main/lease/renew", 409, "fenced", { ttlMs: 1000 }, wrong);
    await c.fail("DELETE", "/refs/main/lease", 409, "fenced", undefined, wrong);
    assert.deepEqual((await c.cas(base.commit, base.commit, {}, c.fenced(lease.epoch))).diff, []);
  });

  await run("2. lease expires at the deadline and acquisition increments the epoch", async c => {
    const base = await c.seed();
    const first = await c.acquire(2000);
    assert.equal(first.version, base.commit);
    assert.equal(first.tree, base.tree);
    // The same holder re-acquiring while it holds is idempotent (same epoch, new deadline); another holder is held.
    const again = await c.request<Lease>("POST", "/refs/main/lease", 200, { holder, ttlMs: 2000 });
    assert.equal(again.epoch, first.epoch); assert.ok(again.deadline >= first.deadline);
    await c.fail("POST", "/refs/main/lease", 409, "held", { holder: { ...holder, mount: holder.mount + "-other" }, ttlMs: 2000 });
    const renewed = await c.request<{ deadline: number }>("POST", "/refs/main/lease/renew", 200, { ttlMs: 2200 }, c.fenced(first.epoch));
    assert.ok(renewed.deadline > first.deadline);
    await c.until(renewed.deadline);
    await c.fail("POST", "/refs/main/lease/renew", 409, "fenced", { ttlMs: 1000 }, c.fenced(first.epoch));
    await c.fail("DELETE", "/refs/main/lease", 409, "fenced", undefined, c.fenced(first.epoch));
    await c.fail("POST", "/refs/main/cas", 409, "fenced", { commit: base.commit, expect: base.commit }, c.fenced(first.epoch));
    const second = await c.acquire();
    assert.equal(second.epoch, first.epoch + 1);
    await c.release(second.epoch);
    assert.equal((await c.acquire()).epoch, second.epoch + 1);
  });

  await run("3. expiry hides unheld refs everywhere and epochs survive expiry and deletion", async c => {
    const base = await c.seed();
    const expiresAt = c.now() + 2200;
    await c.create(base.commit, "other", { expiresAt });
    const lease = await c.acquire(60_000, "other");
    await c.until(expiresAt);
    assert.equal((await c.get("other")).version, base.commit);
    await c.release(lease.epoch, "other");
    await c.fail("GET", "/refs/other", 404, "ref_not_found");
    assert.deepEqual((await c.list()).refs.map(r => r.name), ["main"]);
    for (const [method, path, body] of [
      ["DELETE", "/refs/other", undefined], ["POST", "/refs/other/cas", { commit: base.commit, expect: base.commit }],
      ["POST", "/refs/other/lease", { holder, ttlMs: 1000 }], ["PUT", "/refs/other/watchers/agent:contract", undefined],
    ] as const) await c.fail(method, path, 404, "ref_not_found", body);
    await c.create(base.commit, "other");
    const next = await c.acquire(60_000, "other");
    assert.equal(next.epoch, lease.epoch + 1);
    await c.release(next.epoch, "other");
    await c.request("DELETE", "/refs/other", 204);
    await c.create(base.commit, "other");
    assert.equal((await c.acquire(60_000, "other")).epoch, next.epoch + 1);
  });

  await run("4. holder is a host/boot/mount tuple and all fields must match", async c => {
    const base = await c.seed();
    const { epoch } = await c.acquire();
    assert.deepEqual((await c.get()).holder, holder);
    for (const wrong of [{ ...holder, host: "other" }, { ...holder, boot: 2 }, { ...holder, mount: "other" }]) {
      await c.fail("POST", "/refs/main/cas", 409, "fenced", { commit: base.commit, expect: base.commit }, c.fenced(epoch, wrong));
    }
    await c.release(epoch);
    await c.fail("POST", "/refs/main/lease", 400, "invalid_request", { holder: "host:1:mount", ttlMs: 1000 });
  });

  await run("5. CAS requires expect, never creates, and checks recorded fast-forwards", async c => {
    const base = await c.seed();
    const child = await c.commit([base.commit]);
    const grandchild = await c.commit([child.commit]);
    await c.fail("POST", "/refs/main/cas", 400, "invalid_request", { commit: child.commit });
    await c.fail("POST", "/refs/other/cas", 404, "ref_not_found", { expect: base.commit, commit: child.commit });
    await c.fail("POST", "/refs/main/cas", 400, "unknown_commit", { expect: base.commit, commit: unknown });
    const disjoint = await c.commit([], [], "disjoint");
    const error = await c.fail("POST", "/refs/main/cas", 409, "not_fast_forward", { expect: base.commit, commit: disjoint.commit });
    assert.deepEqual(error.error.details, { current: base.commit });
    assert.equal((await c.cas(base.commit, grandchild.commit)).version, grandchild.commit);
    const joining = await c.commit([disjoint.commit, grandchild.commit]);
    assert.equal((await c.cas(grandchild.commit, joining.commit)).version, joining.commit);
    assert.deepEqual((await c.cas(joining.commit, joining.commit)).diff, []);
    const stale = await c.fail("POST", "/refs/main/cas", 412, "stale", { expect: base.commit, commit: child.commit });
    assert.deepEqual(stale.error.details, { current: joining.commit });
  });

  await t.test("fast-forward rejects a history past 50,000 visited commits", {
    skip: !target.seedHistory && "requires a fixture that can seed 50,000 commits directly",
  }, async () => {
    const c = client(target);
    const base = await c.seed();
    const seedHistory = target.seedHistory!;
    const edge = await seedHistory(c.lin, base.tree, base.commit, 49_999);
    const past = await seedHistory(c.lin, base.tree, edge, 1);
    const error = await c.fail("POST", "/refs/main/cas", 409, "not_fast_forward", { expect: base.commit, commit: past });
    assert.deepEqual(error.error.details, { current: base.commit, reason: "too_deep" });
    assert.equal((await c.get()).version, base.commit);
    assert.equal((await c.cas(base.commit, edge)).version, edge);
  });

  await run("6. DELETE checks expect only when present", async c => {
    const base = await c.seed();
    const error = await c.fail("DELETE", "/refs/main?expect=" + unknown, 412, "stale");
    assert.deepEqual(error.error.details, { current: base.commit });
    await c.request("DELETE", "/refs/main?expect=" + base.commit, 204);
    await c.create(base.commit);
    await c.request("DELETE", "/refs/main", 204);
    await c.fail("GET", "/refs/main", 404, "ref_not_found");
  });

  await run("7. usage is lineage-wide, files recursive, GET creator, CAS sized diff and quota atomicity", async c => {
    const base = await c.seed();
    await c.request("POST", "/refs", 201, { name: "other", version: base.commit, owner }, { claims: { sub: "agent:creator" } });
    assert.equal((await c.get("other")).createdBy, "agent:creator");
    const a = await c.blob("aaa"), b = await c.blob("bb");
    const child = await c.commit([base.commit], [{ path: "dir/a", blob: a.blob }, { path: "dup", blob: a.blob }]);
    await c.request("POST", "/refs/other/cas", 200, { expect: base.commit, commit: child.commit });
    const first = await c.cas(base.commit, child.commit);
    // A real tier's quota B includes blobs uploaded since the last mark,
    // even b, which is not reachable yet. The fake marks live heads only.
    assert.equal(first.bytes, target.advance ? 3 : 5);
    assert.equal(first.files, 2);
    const next = await c.commit([child.commit], [{ path: "dir/a", blob: b.blob }, { path: "dup", delete: true }]);
    const q = { limitBytes: 9, otherBytes: 5 };
    const refused = await c.fail("POST", "/refs/main/cas", 507, "storage_limit", { expect: child.commit, commit: next.commit, quota: q });
    assert.deepEqual(refused.error.details, { limit: 9 });
    assert.equal((await c.get()).version, child.commit);
    const moved = await c.cas(child.commit, next.commit, { quota: { ...q, limitBytes: 10 } });
    assert.equal(moved.bytes, 5);
    assert.equal(moved.files, 1);
    assert.deepEqual(moved.diff, [
      { path: "dir/a", status: "modified", oldBlob: a.blob, newBlob: b.blob, oldMode: "100644", newMode: "100644", oldSize: 3, newSize: 2 },
      { path: "dup", status: "deleted", oldBlob: a.blob, oldMode: "100644", oldSize: 3 },
    ]);
    await c.fail("POST", "/refs/main/write", 507, "storage_limit", { ...meta("quota"), quota: q, changes: [] });
    assert.equal((await c.get()).version, next.commit);
  });

  await run("8. write checks whole-ref and per-path expectations with current/blob/path details", async c => {
    const base = await c.seed();
    const written = await c.write([{ path: "dir/a", text: "hello", expectBlob: "none" }, { path: "b", base64: "aGk=" }], { expect: base.commit });
    assert.deepEqual(written.parents, [base.commit]);
    assert.equal(written.files, 2);
    assert.equal(written.bytes, 7);
    assert.equal(written.changed.length, 2);
    const entry = await c.request<{ blob: string }>("GET", `/trees/${written.tree}/entry?path=dir/a`, 200);
    const pathError = await c.fail("POST", "/refs/main/write", 412, "stale", { ...meta("write"), changes: [{ path: "dir/a", delete: true, expectBlob: "none" }] });
    assert.deepEqual(pathError.error.details, { current: written.version, path: "dir/a", blob: entry.blob });
    const refError = await c.fail("POST", "/refs/main/write", 412, "stale", { ...meta("write"), changes: [], expect: base.commit });
    assert.deepEqual(refError.error.details, { current: written.version });
    const deleted = await c.write([{ path: "dir/a", delete: true, expectBlob: entry.blob }]);
    assert.equal(deleted.files, 1);
  });

  await run("write contention preserves concurrent edits and checks expectations again", async c => {
    const base = await c.seed();
    const rival = await c.commit([base.commit], [{ path: "rival", blob: (await c.blob("rival")).blob }]);
    const changes = [{ path: "mine", text: "mine", expectBlob: "none" }];
    const interceptWrite = target.interceptWrite;
    if (interceptWrite) {
      interceptWrite(async () => { await c.cas(base.commit, rival.commit); });
      const moved = await c.write(changes);
      assert.deepEqual(moved.parents, [rival.commit]);
      assert.equal(moved.files, 2);

      const first = await c.commit([moved.version], [], "first race");
      const second = await c.commit([first.commit], [], "second race");
      interceptWrite(async () => {
        await c.cas(moved.version, first.commit);
        interceptWrite(async () => { await c.cas(first.commit, second.commit); });
      });
      const stale = await c.fail("POST", "/refs/main/write", 412, "stale", { ...meta("twice"), changes: [] });
      assert.deepEqual(stale.error.details, { current: second.commit });

      const third = await c.commit([second.commit], [], "third race");
      interceptWrite(async () => { await c.cas(second.commit, third.commit); });
      const conditional = await c.fail("POST", "/refs/main/write", 412, "stale", { ...meta("expect"), expect: second.commit, changes: [] });
      assert.deepEqual(conditional.error.details, { current: third.commit });

      const blob = await c.blob("new");
      const fourth = await c.commit([third.commit], [{ path: "new", blob: blob.blob }]);
      interceptWrite(async () => { await c.cas(third.commit, fourth.commit); });
      const failingPath = await c.fail("POST", "/refs/main/write", 412, "stale", { ...meta("path"), changes: [{ path: "new", text: "mine", expectBlob: "none" }] });
      assert.deepEqual(failingPath.error.details, { current: fourth.commit, path: "new", blob: blob.blob });
    } else {
      const [r, w] = await Promise.all([
        c.request<{ version?: string; error?: { code: string } }>("POST", "/refs/main/cas", [200, 412], { expect: base.commit, commit: rival.commit }),
        c.write(changes),
      ]);
      if (r.error) assert.equal(r.error.code, "stale");
      else assert.equal(r.version, rival.commit);
      assert.equal((await c.get()).version, w.version);
      assert.deepEqual(w.parents, [r.error ? base.commit : rival.commit]);
      assert.equal(w.files, r.error ? 1 : 2);
    }
  });

  await run("merge, squash, ff-only, conflicts and restore preserve parent rules", async c => {
    const base = await c.seed();
    const a = await c.blob("a"), b = await c.blob("b");
    const ours = await c.commit([base.commit], [{ path: "a", blob: a.blob }]);
    const theirs = await c.commit([base.commit], [{ path: "b", blob: b.blob }]);
    const merge = (mode: string, version = theirs.commit) => ({ ...meta(mode), theirs: version, mode });
    const ff = await c.request<Moved>("POST", "/refs/main/merge", 201, merge("ff-only", ours.commit));
    assert.equal(ff.ff, true);
    assert.deepEqual((ff as Moved & { merged: string[] }).merged, []);
    assert.equal(ff.version, ours.commit);
    assert.equal(ff.bytes, target.advance ? 1 : 2);
    assert.equal(ff.files, 1);
    await c.fail("POST", "/refs/main/merge", 409, "not_fast_forward", merge("ff-only"));
    const conflicting = await c.commit([base.commit], [{ path: "a", blob: b.blob }]);
    await c.fail("POST", "/refs/main/merge", 409, "conflict", merge("merge", conflicting.commit));
    assert.equal((await c.get()).version, ours.commit);
    await c.create(base.commit, "work");
    const alsoFastForward = await c.request<Moved>("POST", "/refs/work/merge", 201, merge("merge", ours.commit));
    assert.equal(alsoFastForward.ff, true);
    assert.equal(alsoFastForward.version, ours.commit);
    await c.create(ours.commit, "other");
    for (const [ref, mode, parents] of [
      ["main", "merge", [ours.commit, theirs.commit]], ["other", "squash", [ours.commit]],
    ] as const) {
      const result = await c.request<Moved>("POST", refPath(ref) + "/merge", 201, merge(mode));
      assert.equal(result.ff, false);
      assert.equal(result.files, 2);
      assert.equal(result.bytes, 2);
      assert.deepEqual((await c.request<Commit>("GET", "/commits/" + result.version, 200)).parents, parents);
    }
    const head = await c.get();
    const restored = await c.request<Moved>("POST", "/refs/main/restore", 201, { ...meta("restore"), version: base.commit });
    assert.equal(restored.tree, base.tree);
    assert.equal(restored.bytes, 2);
    assert.equal(restored.files, 0);
    assert.deepEqual((await c.request<Commit>("GET", "/commits/" + restored.version, 200)).parents, [head.version]);
  });

  await run("watcher PUT/DELETE and token-only fence fields", async c => {
    const base = await c.seed();
    const path = "/refs/main/watchers/agent:watcher";
    await c.request("PUT", path, 204);
    await c.request("DELETE", path, 204);
    await c.fail("PUT", "/refs/main/watchers/invalid", 400, "invalid_request");
    const lease = await c.acquire();
    await c.fail("POST", "/refs/main/cas", 400, "invalid_request", { expect: base.commit, commit: base.commit, fence: { holder, epoch: lease.epoch } });
    await c.fail("POST", "/refs/main/lease/renew", 400, "invalid_request", { ttlMs: 1000, fence: { holder, epoch: lease.epoch } }, c.fenced(lease.epoch));
    await c.fail("DELETE", "/refs/main/lease", 400, "invalid_request", { fence: { holder, epoch: lease.epoch } }, c.fenced(lease.epoch));
    await c.fail("PUT", path, 400, "invalid_request", { url: "https://example.invalid" });
  });

  await run("each mutation replays the first status/body with the same idempotency key", async c => {
    await c.request("PUT", "", 201, c.lineage, { key: "lineage" });
    await c.request("PUT", "", 201, { ...c.lineage, tenant: "different" }, { key: "lineage" });
    const base = await c.commit([]);
    const steps = async (method: string, path: string, status: number, first?: unknown, second?: unknown, opts = {}) => {
      const key = randomUUID();
      const original = await c.request(method, path, status, first, { ...opts, key });
      assert.deepEqual(await c.request(method, path, status, second ?? first, { ...opts, key }), original);
      return original;
    };
    await steps("POST", "/refs", 201, { name: "main", owner, version: base.commit }, { name: "main", owner, version: unknown });
    await steps("POST", "/refs/main/cas", 200, { expect: base.commit, commit: base.commit }, { expect: unknown, commit: unknown });
    const result = await steps("POST", "/refs/main/write", 201, { ...meta("write"), changes: [] }, { ...meta("write"), changes: [], expect: unknown }) as Moved;
    const child = await c.commit([result.version]);
    await steps("POST", "/refs/main/merge", 201, { ...meta("merge"), mode: "ff-only", theirs: child.commit }, { ...meta("merge"), mode: "ff-only", theirs: unknown });
    await steps("POST", "/refs/main/restore", 201, { ...meta("restore"), version: base.commit }, { ...meta("restore"), version: unknown });
    const lease = await steps("POST", "/refs/main/lease", 200, { holder, ttlMs: 60_000 }, { holder: { ...holder, mount: "different" }, ttlMs: 60_000 }) as Lease;
    await steps("POST", "/refs/main/lease/renew", 200, { ttlMs: 60_000 }, { ttlMs: 500 }, c.fenced(lease.epoch));
    await steps("DELETE", "/refs/main/lease", 204, undefined, undefined, c.fenced(lease.epoch));
    await steps("PUT", "/refs/main/watchers/agent:contract", 204);
    await steps("DELETE", "/refs/main/watchers/agent:contract", 204);
    await steps("DELETE", "/refs/main", 204);
    await c.create(base.commit);
    await steps("DELETE", "/refs?owner=" + encodeURIComponent(owner), 200);
  });

  await run("tokens refuse invalid envelopes, scope, access, globs and service subjects", async c => {
    const base = await c.seed();
    const now = Math.floor(c.now() / 1000);
    const token = target.mint(c.claims());
    const forbidden = await c.fail("POST", "/refs", 403, "forbidden",
      { name: "other", version: base.commit, owner }, { claims: { acc: "r" } });
    assert.ok(forbidden.error.message && forbidden.error.message !== "forbidden");
    const signature = token.lastIndexOf(".") + 1;
    for (const opts of [
      { token: null }, { token: "shared-bearer" }, { token: token + "=" },
      { token: token.slice(0, signature) + (token[signature] === "A" ? "B" : "A") + token.slice(signature + 1) },
      { header: { alg: "HS256" } }, { header: { typ: "file+jwt" } }, { header: { kid: "missing" } }, { header: { jwk: {} } },
      { claims: { aud: "camelrun:file" } }, { claims: { iss: "wrong" } }, { claims: { exp: undefined } },
      { claims: { iat: now - 60, exp: now } }, { claims: { iat: now, exp: now + 901 } },
      { claims: { iat: now + 30, exp: now + 60 } }, { claims: { acc: "rw" } },
      { claims: { refs: ["pub/?"] } }, { claims: { fence: { epoch: 1 } } },
    ]) assert.ok((await c.fail("GET", "/refs/main", 401, "unauthorized", undefined, opts)).error.message);
    await c.fail("GET", "/refs/main", 403, "forbidden", undefined, { claims: { lin: "contract:wrong" } });
    await c.request("GET", "/refs/main", 200, undefined, { claims: { acc: "r", refs: [], extra: true } });
    await c.request("GET", "/refs/main", 200, undefined, { claims: { acc: "w", refs: [] } });
    const create = { name: "pub/a", version: base.commit, owner };
    await c.fail("POST", "/refs", 403, "forbidden", create, { claims: { acc: "r" } });
    await c.fail("POST", "/refs", 403, "forbidden", create, { claims: { refs: ["main"] } });
    await c.fail("POST", "/refs", 403, "forbidden", { ...create, name: "pub/a/b" }, { claims: { refs: ["pub/*"] } });
    await c.request("POST", "/refs", 201, create, { claims: { refs: ["pub/*"] } });
    const agent = { claims: { sub: "agent:caller" } };
    await c.fail("POST", "/refs/main/lease", 403, "forbidden", { holder, ttlMs: 1000 }, agent);
    await c.fail("POST", "/refs/main/lease/renew", 403, "forbidden", { ttlMs: 1000 }, agent);
    await c.fail("DELETE", "/refs/main/lease", 403, "forbidden", undefined, agent);
    await c.fail("PUT", "/refs/main/watchers/agent:x", 403, "forbidden", undefined, agent);
    await c.fail("DELETE", "/refs/main/watchers/agent:x", 403, "forbidden", undefined, agent);
  });

  await run("delete by owner reports held refs and removes live unheld refs only", async c => {
    const base = await c.seed();
    await c.create(base.commit, "other");
    await c.create(base.commit, "work", { owner: "job:another" });
    await c.create(base.commit, "pub/expired", { expiresAt: c.now() - 1 });
    const lease = await c.acquire();
    const path = "/refs?owner=" + encodeURIComponent(owner);
    await c.fail("DELETE", path, 403, "forbidden", undefined, { claims: { acc: "r" } });
    assert.deepEqual(await c.request("DELETE", path, 200, undefined, { claims: { refs: [], sub: "agent:caller" } }),
      { deleted: ["other"], held: ["main"] });
    assert.deepEqual((await c.list()).refs.map(r => r.name), ["main", "work"]);
    await c.release(lease.epoch);
    assert.deepEqual(await c.request("DELETE", path, 200), { deleted: ["main"], held: [] });
  });

  await run("lineage delete is runtime-only, refuses live holds, and tombstones every route", async c => {
    const base = await c.seed();
    await c.create(base.commit, "other");
    const { epoch } = await c.acquire();
    await c.fail("DELETE", "", 403, "forbidden", undefined, { claims: { sub: "agent:caller" } });
    const error = await c.fail("DELETE", "", 409, "held");
    assert.deepEqual(error.error.details, { held: ["main"] });
    assert.equal((await c.get("other")).version, base.commit);
    await c.release(epoch);
    await c.request("DELETE", "", 204, undefined, { key: "delete-lineage" });
    await c.request("DELETE", "", 204, undefined, { key: "delete-lineage" });
    await c.fail("DELETE", "", 410, "lineage_deleted", undefined, { key: "delete-lineage-again" });
    for (const [method, path, body] of [
      ["GET", "", undefined], ["PUT", "", c.lineage], ["DELETE", "", undefined], ["GET", "/refs", undefined],
      ["DELETE", "/refs?owner=" + encodeURIComponent(owner), undefined], ["GET", "/refs/main", undefined],
      ["POST", "/refs", { name: "main", owner, version: base.commit }], ["GET", "/commits/" + base.commit, undefined],
      ["POST", "/refs/main/lease", { holder, ttlMs: 1000 }],
    ] as const) await c.fail(method, path, 410, "lineage_deleted", body);
  });
}
