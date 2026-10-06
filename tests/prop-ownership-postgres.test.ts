import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import pg from "pg";
import { Ownership, underClaim, LostClaim, type Claim } from "../src/ownership.ts";
import { postgresTail } from "../src/log-tail.ts";
import type { TailRow } from "../shared/storage.ts";
import type { Db } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { check } from "./prop-helpers.ts";

/**
 * Fencing on real Postgres, with sessions racing for row locks (which PGlite's single session cannot show).
 * Node A owns an actor and appends to its log tail, compacts the tail into object storage and makes fenced writes
 * (`underClaim`), while B, and sometimes C, end A's heartbeat (as `reap` does), take the actor over and append and
 * write in turn. Every statement of every node, transaction statements included, waits on `fc.scheduler()`, which
 * orders them across the nodes' connections; a statement it lets through may then wait on another's lock.
 *
 * - I1: of the nodes racing to take over, exactly one gets a claim, with a higher epoch, and the others are told
 *   who owns the actor; the fenced writes that commit are all A's, then all the successor's.
 * - I2/I7: the log (moved and tail rows) is gap-free; every append acknowledged is in it and no rejected append's
 *   rows are; and no record of A follows one of its successor's.
 */

type Op = "append" | "append2" | "effect" | "compact";

let url: string;
let admin: pg.Pool;
const pools: pg.Pool[] = [];
let runs = 0;
before(async () => {
  ({ url, db: admin } = await testDatabase() as { url: string; db: pg.Pool });
  await admin.query("create table effects (id bigserial primary key, actor text not null, node text not null, epoch bigint not null)");
  for (let index = 0; index < 3; index++) pools.push(new pg.Pool({ connectionString: url, max: 4 }));
});
after(async () => { for (const pool of pools) await pool.end(); });

/** A node's view of the database: while `gate` is set, each statement first waits for the scheduler. */
function nodeDb(pool: pg.Pool, name: string, link: { gate?: (label: string) => Promise<void> }): Db {
  const label = (text: string) => `${name}: ${text.trim().split(/\s+/).slice(0, 3).join(" ")}`;
  return {
    query: async (text: string, values?: unknown[]) => {
      await link.gate?.(label(text));
      if (link.gate && name !== "http://a" && text.includes("insert into actor_owners") && open.has("http://a")) seen.takeoverWaitedOnLock++;
      return pool.query(text, values);
    },
    connect: async () => {
      // A view of the pooled client, not the client itself: the pool's own queries must not be gated.
      const client = await pool.connect();
      return {
        query: async (text: string, values?: unknown[]) => {
          if (text !== "rollback") await link.gate?.(label(text));
          if (text === "begin") open.add(name); else if (text === "commit" || text === "rollback") open.delete(name);
          return client.query(text, values);
        },
        release: (error?: Error) => client.release(error), on: client.on.bind(client), off: client.off.bind(client),
      };
    },
  } as unknown as Db;
}

/** How often the races that matter happened, over all runs. */
const seen = { runs: 0, fencedAppends: 0, fencedWrites: 0, fencedCompactions: 0, takeoverWaitedOnLock: 0, contenderLost: 0, successorAppends: 0 };
/** Nodes with a transaction open (between begin and commit), to count takeovers released while A holds its lock. */
const open = new Set<string>();

interface Written { node: string; rows: TailRow[]; acked: boolean }

async function race(scheduler: fc.Scheduler, opsA: Op[], opsB: Op[], contender: boolean) {
  const run = ++runs;
  seen.runs++;
  open.clear();
  const actor = `agent_${run}`, key = `agents/${run}/transcript`;
  const link: { gate?: (label: string) => Promise<void> } = {};
  const names = ["http://a", "http://b", "http://c"];
  const dbs = names.map((name, index) => nodeDb(pools[index], name, link));
  const owners = names.map((name, index) => new Ownership(dbs[index], { node: name }));
  const tails = dbs.map(db => postgresTail(db));
  /** Object storage: the rows compactions moved out of the tail. */
  const moved: TailRow[] = [];
  const written: Written[] = [];
  const effects: { node: string; committed: boolean }[] = [];

  const first = await owners[0].acquire(actor);
  assert.ok("claim" in first);
  link.gate = label => scheduler.schedule(Promise.resolve(), label).then(() => {});

  /** A writer's operations under its claim, appending from `next`. Once fenced, every later operation must fail too. */
  const writer = async (index: number, claim: Claim, next: number, ops: Op[]) => {
    for (const op of ops) {
      if (op === "append" || op === "append2") {
        const rows = Array.from({ length: op === "append" ? 1 : 2 }, (_, offset) => ({ seq: next + offset, snapshot: false, body: `${names[index]} ${next + offset}`, blob: null }));
        const acked = await tails[index].append(key, claim, rows);
        written.push({ node: names[index], rows, acked });
        if (!acked && index === 0) seen.fencedAppends++;
        if (acked && index > 0) seen.successorAppends++;
        if (acked) next += rows.length;
      } else if (op === "effect") {
        let committed = true;
        try { await underClaim(dbs[index], claim, sql => sql.query("insert into effects (actor, node, epoch) values ($1, $2, $3)", [actor, names[index], claim.epoch])); }
        catch (error) { if (!(error instanceof LostClaim)) throw error; committed = false; seen.fencedWrites++; }
        effects.push({ node: names[index], committed });
      } else {
        if (!await tails[index].compact(key, claim, async rows => { moved.push(...rows); return rows.at(-1)!.seq; })) seen.fencedCompactions++;
      }
    }
  };
  /** Peers end A's heartbeat (as `reap` does once its process is gone), then take the actor and write in turn. */
  const successor = async (index: number) => {
    await dbs[index].query("delete from runtime_nodes where node = $1", [names[0]]);
    const result = await owners[index].acquire(actor);
    if ("owner" in result) { seen.contenderLost++; return result; }
    const last = await tails[index].last(key);
    const next = Math.max(last ?? -1, ...moved.map(row => row.seq)) + 1;
    await writer(index, result.claim, next, opsB);
    return result;
  };
  const tasks = [writer(0, first.claim, 0, opsA), successor(1), ...(contender ? [successor(2)] : [])];
  const [, ...results] = await scheduler.waitFor(Promise.all(tasks));
  link.gate = undefined;

  // I1: one successor took the actor, with a higher epoch; any other was told who owns it.
  const claims = results.filter(result => result && "claim" in result) as { claim: Claim }[];
  assert.equal(claims.length, 1, `exactly one successor takes the actor: ${JSON.stringify(results)}, row ${JSON.stringify((await admin.query("select node, epoch from actor_owners where actor = $1", [actor])).rows)}`);
  assert.ok(claims[0].claim.epoch > first.claim.epoch, "with a higher epoch");
  const winner = names[(results as object[]).indexOf(claims[0]) + 1];
  for (const result of results) if (result && "owner" in result) assert.equal(result.owner, winner, "a successor that lost is told who owns the actor");

  // I2/I7: the log is gap-free; acknowledged appends are in it, rejected ones are not; A's records precede the successor's.
  const tail = await tails[0].rows(key);
  const log = [...moved, ...tail].sort((a, b) => a.seq - b.seq);
  assert.deepEqual(log.map(row => row.seq), log.map((_, index) => index), "the log is gap-free, each sequence number once");
  const bodies = new Set(log.map(row => row.body));
  for (const { node, rows, acked } of written) {
    const present = rows.filter(row => bodies.has(row.body)).length;
    if (acked) assert.equal(present, rows.length, `${node}'s acknowledged append of ${rows.map(row => row.seq)} is in the log`);
    else assert.equal(present, 0, `${node}'s rejected append of ${rows.map(row => row.seq)} left nothing in the log`);
  }
  const writers = log.map(row => row.body!.split(" ")[0]);
  const firstSuccessor = writers.findIndex(name => name !== names[0]);
  if (firstSuccessor >= 0) assert.ok(writers.slice(firstSuccessor).every(name => name === winner), `no record of A follows its successor's: ${writers.join(", ")}`);

  // I1: the fenced writes that committed are all A's, then all the successor's.
  const { rows: committed } = await admin.query("select node, epoch from effects where actor = $1 order by id", [actor]);
  assert.equal(committed.length, effects.filter(effect => effect.committed).length, "every write that committed said so, and only those");
  const order = committed.map(row => row.node);
  const handover = order.findIndex(name => name !== names[0]);
  if (handover >= 0) assert.ok(order.slice(handover).every(name => name === winner), `fenced writes: ${order.join(", ")}`);
  for (const ownership of owners) await ownership.close();
}

const ops = fc.array(fc.constantFrom<Op>("append", "append2", "effect", "compact"), { minLength: 1, maxLength: 5 });

test("on Postgres, a takeover racing the old owner's appends, compactions and fenced writes leaves one owner and an ordered log (I1, I2, I7)", async t => {
  await check(t, fc.asyncProperty(fc.scheduler(), ops, ops, fc.boolean(), race), { runs: 100 });
  console.log(JSON.stringify({ type: "postgres_race_coverage", ...seen }));
});
