import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import pg from "pg";
import type { Db } from "../src/db.ts";
import { FRESH_RENEWALS, Ownership, probeNode, SUSPECT_RENEWALS } from "../src/ownership.ts";
import { testDatabase } from "./database.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A node's own connection pool, which a test can partition from the database and whose statements it counts. */
async function node(url: string, name: string, ttlMs = 30_000, alive?: (node: string) => Promise<boolean>) {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const link = { partitioned: false, statements: [] as string[], after: undefined as ((text: string) => Promise<void>) | undefined };
  const db = {
    query: async (text: string, values?: unknown[]) => {
      link.statements.push(text.trim().split(/\s+/)[0]);
      if (link.partitioned) throw new Error("connection refused");
      const result = await pool.query(text, values);
      await link.after?.(text);
      return result;
    },
  } as unknown as Db;
  const ownership = new Ownership(db, { node: name, ttlMs, alive });
  const fences: string[] = [];
  ownership.onFence(reason => fences.push(reason));
  await ownership.start();
  return { ownership, link, fences, stop: async () => { await ownership.close().catch(() => {}); await pool.end(); } };
}

/** Bounds on the database's clock minus this process's, from the quickest of a few round trips. */
async function databaseClock(db: pg.Pool) {
  let best = { low: -Infinity, high: Infinity };
  for (let index = 0; index < 5; index++) {
    const sent = Date.now();
    const { rows } = await db.query("select extract(epoch from clock_timestamp()) * 1000 as ms");
    const received = Date.now(), at = Number(rows[0].ms);
    if (received - sent < best.high - best.low) best = { low: at - received - 1, high: at - sent + 1 };
  }
  return best;
}

test("one node owns an actor at a time, even when nodes race for many actors", async t => {
  const { url } = await testDatabase();
  const a = await node(url, "http://a"), b = await node(url, "http://b");
  t.after(async () => { await a.stop(); await b.stop(); });
  const first = await a.ownership.acquire("client_x");
  assert.ok("claim" in first && first.claim.epoch === 1);
  assert.deepEqual(await b.ownership.acquire("client_x"), { owner: "http://a" });
  assert.equal(await b.ownership.owner("client_x"), "http://a");

  const actors = Array.from({ length: 40 }, (_, index) => `vol_${index}`);
  const results = await Promise.all(actors.flatMap(actor => [a, b].map(async n => ({ actor, node: n.ownership.node, result: await n.ownership.acquire(actor) }))));
  for (const actor of actors) {
    const won = results.filter(entry => entry.actor === actor && "claim" in entry.result);
    assert.equal(won.length, 1, `${actor} has one owner`);
    const lost = results.find(entry => entry.actor === actor && "owner" in entry.result)!;
    assert.equal((lost.result as { owner: string }).owner, won[0].node);
  }
});

test("a released actor moves at once with a higher epoch; a stale release changes nothing", async t => {
  const { url } = await testDatabase();
  const a = await node(url, "http://a"), b = await node(url, "http://b");
  t.after(async () => { await a.stop(); await b.stop(); });
  const first = await a.ownership.acquire("client_y");
  assert.ok("claim" in first);
  await a.ownership.release(first.claim);
  assert.equal(await b.ownership.owner("client_y"), undefined);
  const second = await b.ownership.acquire("client_y");
  assert.ok("claim" in second && second.claim.epoch === 2);
  await a.ownership.release(first.claim);
  assert.equal(await a.ownership.owner("client_y"), "http://b");
  const again = await b.ownership.acquire("client_y");
  assert.ok("claim" in again && again.claim.epoch === 3, "every acquire advances the epoch, even the owner's own");
});

test("renewal is one write per node, however many actors it owns", async t => {
  const { url } = await testDatabase();
  const a = await node(url, "http://a");
  t.after(() => a.stop());
  for (let index = 0; index < 50; index++) assert.ok("claim" in await a.ownership.acquire(`client_${index}`));
  a.link.statements.length = 0;
  await a.ownership.renew();
  assert.deepEqual(a.link.statements, ["update"]);
});

test("a node that cannot renew fences itself before its published expiry, and a peer then takes over with a new epoch", async t => {
  const { db, url } = await testDatabase();
  const a = await node(url, "http://a", 1_500), b = await node(url, "http://b", 1_500);
  t.after(async () => { await a.stop(); await b.stop(); });
  const held = await a.ownership.acquire("client_z");
  assert.ok("claim" in held);

  // Times are taken here and compared with the database's clock afterwards, so a slow query cannot fail the test, only a late fence or an early takeover.
  let fencedAt = 0;
  a.ownership.onFence(() => { fencedAt = Date.now(); });
  a.link.partitioned = true;
  for (let waited = 0; !fencedAt; waited += 5) { assert.ok(waited < 3_000, "the node fenced"); await sleep(5); }
  assert.deepEqual(a.fences, ["heartbeat_expired"]);
  assert.equal(a.ownership.holds(held.claim), false);

  // From the fence on, a peer keeps trying to take the actor.
  const attempts: { sent: number; received: number; taken: boolean }[] = [];
  for (let taken = false; !taken; await sleep(25)) {
    assert.ok(attempts.length < 120, "a peer took over once the heartbeat expired");
    const sent = Date.now(), result = await b.ownership.acquire("client_z");
    taken = "claim" in result;
    if (taken) assert.equal((result as { claim: { epoch: number } }).claim.epoch, held.claim.epoch + 1);
    attempts.push({ sent, received: Date.now(), taken });
  }
  const expires = Number((await db.query("select extract(epoch from expires_at) * 1000 as ms from runtime_nodes where node = 'http://a'")).rows[0].ms);
  const clock = await databaseClock(db);
  assert.ok(fencedAt + clock.high < expires, "the node stopped serving while its heartbeat still looked live to peers");
  const takeover = attempts.at(-1)!;
  assert.ok(takeover.received + clock.high >= expires, "peers wait for the published expiry");

  // Reconnected, the fenced node rejoins under a new session; the actor stays where it moved.
  a.link.partitioned = false;
  assert.deepEqual(await a.ownership.acquire("client_z"), { owner: "http://b" });
  const fresh = await a.ownership.acquire("client_new");
  assert.ok("claim" in fresh && fresh.claim.session !== held.claim.session);
});

test("a node whose event loop was blocked past its deadline holds nothing, even before its late watchdog runs", async t => {
  const { url } = await testDatabase();
  const a = await node(url, "http://a", 600);
  t.after(() => a.stop());
  const held = await a.ownership.acquire("client_blocked");
  assert.ok("claim" in held);
  assert.equal(a.ownership.holds(held.claim), true);
  a.link.partitioned = true;
  // Nothing else runs while the loop is blocked: not the renewal, not the watchdog.
  const until = performance.now() + 600;
  while (performance.now() < until);
  assert.deepEqual(a.fences, [], "the watchdog has not run yet");
  assert.equal(a.ownership.holds(held.claim), false, "work resumed after the block must not act on the actor");
});

test("an acquire that races a heartbeat expiring between its two statements retries instead of failing", async t => {
  const { db, url } = await testDatabase();
  const a = await node(url, "http://a"), b = await node(url, "http://b");
  t.after(async () => { await a.stop(); await b.stop(); });
  assert.ok("claim" in await a.ownership.acquire("client_edge"));
  // a's heartbeat expires right after b's insert saw it live, before b asks who owns the actor.
  b.link.after = async text => {
    if (!text.includes("insert into actor_owners")) return;
    b.link.after = undefined;
    await db.query("update runtime_nodes set expires_at = now() - interval '1 millisecond' where node = 'http://a'");
  };
  const taken = await b.ownership.acquire("client_edge");
  assert.ok("claim" in taken && taken.claim.epoch === 2, "the second attempt takes the expired owner's actor");
});

test("a node whose heartbeat row was replaced fences at once", async t => {
  const { url } = await testDatabase();
  const a = await node(url, "http://a");
  t.after(() => a.stop());
  const held = await a.ownership.acquire("client_q");
  assert.ok("claim" in held);
  // Another process started with the same address and took over the heartbeat.
  const impostor = await node(url, "http://a");
  t.after(() => impostor.stop());
  await a.ownership.renew();
  assert.deepEqual(a.fences, ["heartbeat_replaced"]);
  assert.equal(a.ownership.holds(held.claim), false);
  const taken = await impostor.ownership.acquire("client_q");
  assert.ok("claim" in taken && taken.claim.epoch === 2, "the old session's claims are dead at once");
});

test("the owner cache is a hint: callers drop stale entries, and none outlives its owner's heartbeat", async t => {
  const { db, url } = await testDatabase();
  const a = await node(url, "http://a", 60_000), b = await node(url, "http://b");
  t.after(async () => { await a.stop(); await b.stop(); });
  const held = await a.ownership.acquire("client_c");
  assert.ok("claim" in held);
  assert.equal(await b.ownership.route("client_c"), "http://a");
  b.link.statements.length = 0;
  assert.equal(await b.ownership.route("client_c"), "http://a");
  assert.deepEqual(b.link.statements, [], "a fresh entry needs no query");

  // The actor moved on: the entry still names the old owner until a caller forgets it, and ownership itself is never cached.
  await a.ownership.release(held.claim);
  assert.equal(await b.ownership.route("client_c"), "http://a");
  assert.ok("claim" in await b.ownership.acquire("client_c"));
  assert.equal(await b.ownership.route("client_c"), "http://b", "taking the actor drops the entry");

  const again = await a.ownership.acquire("client_d");
  assert.ok("claim" in again);
  assert.equal(await b.ownership.route("client_d"), "http://a");
  b.ownership.forget("client_d");
  await a.ownership.release(again.claim);
  assert.equal(await b.ownership.route("client_d"), undefined);

  // An entry lasts only as long as the heartbeat looked live when it was read.
  assert.ok("claim" in await a.ownership.acquire("client_e"));
  await db.query("update runtime_nodes set expires_at = now() + interval '300 milliseconds' where node = 'http://a'");
  assert.equal(await b.ownership.route("client_e"), "http://a");
  await sleep(400);
  assert.equal(await b.ownership.route("client_e"), undefined);
});

test("a draining node takes nothing new, sends unowned actors to a live peer, and peers stop picking it", async t => {
  const { url } = await testDatabase();
  const a = await node(url, "http://a"), b = await node(url, "http://b"), c = await node(url, "http://c");
  t.after(async () => { await a.stop(); await b.stop(); await c.stop(); });
  const held = await a.ownership.acquire("client_kept");
  assert.ok("claim" in held);
  assert.ok("claim" in await b.ownership.acquire("client_elsewhere"));
  await a.ownership.drain();

  await assert.rejects(a.ownership.acquire("client_new"), (error: any) => error.status === 503);
  assert.deepEqual(await a.ownership.acquire("client_elsewhere"), { owner: "http://b" });
  assert.ok(["http://b", "http://c"].includes((await a.ownership.route("client_new"))!));
  assert.equal(a.ownership.holds(held.claim), true, "what it owns it keeps serving");
  assert.equal(await b.ownership.route("client_kept"), "http://a");
  for (let index = 0; index < 10; index++) assert.equal(await b.ownership.peer(), "http://c");
  await c.ownership.drain();
  b.ownership.forget();
  assert.equal(await b.ownership.peer(), undefined);
});

/** Make `name`'s heartbeat look as if its last renewal was `lateMs` ago, by the database's clock. */
const late = (db: pg.Pool, name: string, ttlMs: number, lateMs: number) =>
  db.query("update runtime_nodes set expires_at = now() + $2 * interval '1 millisecond' where node = $1", [name, ttlMs - lateMs]);

test("a peer ends a late heartbeat whose node is gone: its actors move at once with a higher epoch, and the node fences if it comes back", async t => {
  const { db, url } = await testDatabase();
  const gone = new Set<string>();
  const alive = async (name: string) => !gone.has(name);
  const a = await node(url, "http://a", 30_000, alive), b = await node(url, "http://b", 30_000, alive);
  t.after(async () => { await a.stop(); await b.stop(); });
  const reaped: string[][] = [];
  b.ownership.onReaped(nodes => reaped.push(nodes));
  const held = await a.ownership.acquire("client_r");
  assert.ok("claim" in held);
  a.link.partitioned = true;
  gone.add("http://a");

  // Two renewals late is not yet a suspect; three is.
  await late(db, "http://a", 30_000, 2 * b.ownership.heartbeatMs);
  assert.deepEqual(await b.ownership.reap(), []);
  assert.deepEqual(await b.ownership.acquire("client_r"), { owner: "http://a" });
  await late(db, "http://a", 30_000, 3 * b.ownership.heartbeatMs + 100);
  assert.deepEqual(await b.ownership.reap(), ["http://a"]);
  assert.deepEqual(reaped, [["http://a"]]);
  const taken = await b.ownership.acquire("client_r");
  assert.ok("claim" in taken && taken.claim.epoch === held.claim.epoch + 1, "taken long before the 30 s expiry");

  // Back, it cannot renew the heartbeat a peer ended: it fences, and the actor stays where it moved.
  a.link.partitioned = false;
  await a.ownership.renew();
  assert.deepEqual(a.fences, ["heartbeat_replaced"]);
  assert.equal(a.ownership.holds(held.claim), false);
  assert.deepEqual(await a.ownership.acquire("client_r"), { owner: "http://b" });
});

test("a late heartbeat whose node still accepts connections is left to expire, and a timely one is not probed", async t => {
  const { db, url } = await testDatabase();
  const probed: string[] = [];
  const alive = async (name: string) => { probed.push(name); return true; };
  const a = await node(url, "http://a", 30_000, alive), b = await node(url, "http://b", 30_000, alive), c = await node(url, "http://c", 30_000, alive);
  t.after(async () => { await a.stop(); await b.stop(); await c.stop(); });
  assert.ok("claim" in await a.ownership.acquire("client_s"));
  // A stalled node, or one cut off from the database: late, but its process runs.
  a.link.partitioned = true;
  await late(db, "http://a", 30_000, 20_000);
  probed.length = 0;
  assert.deepEqual(await b.ownership.reap(), []);
  assert.deepEqual(probed, ["http://a"]);
  assert.deepEqual(await b.ownership.acquire("client_s"), { owner: "http://a" });
});

test("an expired heartbeat is never renewed: its node fences instead", async t => {
  const { db, url } = await testDatabase();
  const a = await node(url, "http://a");
  t.after(() => a.stop());
  const held = await a.ownership.acquire("client_t");
  assert.ok("claim" in held);
  await db.query("update runtime_nodes set expires_at = now() - interval '1 millisecond' where node = 'http://a'");
  await a.ownership.renew();
  assert.deepEqual(a.fences, ["heartbeat_replaced"]);
  assert.equal(a.ownership.holds(held.claim), false);
});

test("a fresh lease ends a heartbeat before peers could suspect the node, from the same constants", () => {
  for (const ttlMs of [1_500, 12_000, 90_000, 600_000]) {
    const ownership = new Ownership({} as Db, { node: "http://a", ttlMs });
    // New effects stop at freshMs; model requests in flight are cut at most half a heartbeat later; peers suspect at SUSPECT_RENEWALS.
    assert.equal(ownership.freshMs, FRESH_RENEWALS * ownership.heartbeatMs);
    assert.ok(ownership.freshMs + ownership.heartbeatMs / 2 < SUSPECT_RENEWALS * ownership.heartbeatMs);
    assert.ok(ownership.freshMs < ttlMs * 0.9, "fresh ends before the fence");
  }
});

test("a node cut off from the database stops being fresh two renewals in, cuts its model requests, waits, and goes on once a renewal lands, without fencing", async t => {
  const { url } = await testDatabase();
  const a = await node(url, "http://a", 1_500);
  t.after(() => a.stop());
  const held = await a.ownership.acquire("client_f");
  assert.ok("claim" in held);
  assert.equal(a.ownership.fresh(), true);
  await a.ownership.whenFresh();
  const cut: number[] = [];
  a.ownership.onStale(() => cut.push(performance.now()));

  const partitioned = performance.now();
  a.link.partitioned = true;
  for (; a.ownership.fresh(); await sleep(5)) assert.ok(performance.now() - partitioned < a.ownership.freshMs + 100, "the lease went stale");
  const staleAfter = performance.now() - partitioned;
  assert.ok(staleAfter <= a.ownership.freshMs + 50, `stale ${staleAfter} ms after the partition`);
  assert.equal(a.ownership.holds(held.claim), true, "stale is not fenced: the claim holds until the deadline");
  // An effect now waits.
  let waited: number | undefined;
  const waiting = a.ownership.whenFresh().then(() => { waited = performance.now(); });
  await sleep(a.ownership.heartbeatMs);
  assert.equal(waited, undefined, "effects wait while the lease is stale");
  assert.equal(cut.length, 1, "model requests in flight were cut half a heartbeat after it went stale");
  assert.ok(cut[0] - partitioned < SUSPECT_RENEWALS * a.ownership.heartbeatMs, "before peers could suspect the node");
  // An effect that gives up waiting.
  const aborted = new AbortController();
  const abandoned = a.ownership.whenFresh(aborted.signal);
  aborted.abort(new Error("run aborted"));
  await assert.rejects(abandoned, /run aborted/);

  const healed = performance.now();
  a.link.partitioned = false;
  await waiting;
  assert.ok(waited! - healed < a.ownership.heartbeatMs + 200, "effects went on at the next renewal");
  assert.equal(a.ownership.fresh(), true);
  assert.deepEqual(a.fences, [], "a pause shorter than the lease never fences");
  assert.equal(a.ownership.holds(held.claim), true);
});

test("an effect waiting on a stale lease gives up when the node fences, and the claim it held stays lost", async t => {
  const { url } = await testDatabase();
  const a = await node(url, "http://a", 600);
  t.after(() => a.stop());
  const held = await a.ownership.acquire("client_g");
  assert.ok("claim" in held);
  a.link.partitioned = true;
  for (; a.ownership.fresh(); await sleep(5));
  const waiting = a.ownership.whenFresh();
  waiting.catch(() => {});
  // At the deadline the node fences; a waiting effect then tries to rejoin, which the partition refuses.
  await assert.rejects(waiting, /connection refused/);
  assert.deepEqual(a.fences, ["heartbeat_expired"]);
  a.link.partitioned = false;
  await a.ownership.whenFresh();
  assert.equal(a.ownership.fresh(), true, "rejoined under a new session");
  assert.equal(a.ownership.holds(held.claim), false);
});

test("probeNode: a listening address is alive; a closed port is gone; an address it cannot resolve or parse is assumed alive", async () => {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  assert.equal(await probeNode(`http://127.0.0.1:${port}`), true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await probeNode(`http://127.0.0.1:${port}`), false);
  assert.equal(await probeNode("http://no-such-node.invalid:8790"), true);
  assert.equal(await probeNode("first"), true);
});
