import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { Db } from "../src/db.ts";
import { Ownership } from "../src/ownership.ts";
import { testDatabase } from "./database.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A node's own connection pool, which a test can partition from the database and whose statements it counts. */
async function node(url: string, name: string, ttlMs = 30_000) {
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
  const ownership = new Ownership(db, { node: name, ttlMs });
  const fences: string[] = [];
  ownership.onFence(reason => fences.push(reason));
  await ownership.start();
  return { ownership, link, fences, stop: async () => { await ownership.close().catch(() => {}); await pool.end(); } };
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
  // The node fences a tenth of the TTL before its published expiry; the checks below must reach the database within that margin.
  const a = await node(url, "http://a", 1_500), b = await node(url, "http://b", 1_500);
  t.after(async () => { await a.stop(); await b.stop(); });
  const held = await a.ownership.acquire("client_z");
  assert.ok("claim" in held);

  // Asked the moment the node fences, so no test delay eats into the margin.
  let atFence: Promise<[boolean, unknown]> | undefined;
  a.ownership.onFence(() => {
    atFence = Promise.all([
      db.query("select expires_at > now() as live from runtime_nodes where node = 'http://a'").then(({ rows }) => rows[0].live as boolean),
      b.ownership.acquire("client_z"),
    ]);
  });
  a.link.partitioned = true;
  for (let waited = 0; !a.fences.length; waited += 25) { assert.ok(waited < 3_000, "the node fenced"); await sleep(25); }
  assert.deepEqual(a.fences, ["heartbeat_expired"]);
  assert.equal(a.ownership.holds(held.claim), false);
  const [liveAtFence, peerAtFence] = await atFence!;
  assert.equal(liveAtFence, true, "the node stopped serving while its heartbeat still looked live to peers");
  assert.deepEqual(peerAtFence, { owner: "http://a" }, "peers wait for the published expiry");

  for (let waited = 0; ; waited += 50) {
    const taken = await b.ownership.acquire("client_z");
    if ("claim" in taken) { assert.equal(taken.claim.epoch, held.claim.epoch + 1); break; }
    assert.ok(waited < 3_000, "a peer took over once the heartbeat expired");
    await sleep(50);
  }

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
