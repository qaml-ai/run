import { test } from "node:test";
import assert from "node:assert/strict";
import { landDelegate, type DelegationContext } from "../src/client-sessions/delegation.ts";
import { sweepChildren, type ChildrenContext } from "../src/client-sessions/children.ts";
import type { Session } from "../src/client-sessions/state.ts";
import { testDatabase } from "./database.ts";

// A delegate child's spend is charged to its parent's spend limit exactly once, whichever of the call (on any node, made
// again after its node was lost), the parent's stop or the late sweep lands it. The landing and the charge are one
// transaction, guarded by `landed_at is null`.

const COST = 0.15;
const record = { state: "completed", status: "completed", outcome: { result: { reply: "done", usage: { costUsd: COST } } } } as any;

async function setup() {
  const { db } = await testDatabase();
  const parent = `client_parent_${Math.random().toString(36).slice(2)}`;
  await db.query("insert into agent_spend_limits (agent, usd, spent, set_at) values ($1, 10, 0, 1)", [parent]);
  await db.query(`insert into agent_children (id, tenant, parent, child, request_id, name, depth, root, parent_run, tool_call_id, kind, made, checked_at, created_at, updated_at)
    values ('delegate_k', 't', $1, 'client_child', 'delegate_k', 'subagent', 1, $1, 'run_1', 'call_1', 'delegate', true, 0, 2, 2)`, [parent]);
  /** A node serving the parent: its own session, with the limit as it read it. */
  const node = () => {
    const session = { header: { id: parent, tenant: "t" }, running: new Map([["run_1", {}]]) } as unknown as Session;
    const ctx = {
      db,
      spendContext: {
        spendOf: async (s: Session) => {
          if (s.spend === undefined) { const row = (await db.query("select usd, spent, set_at from agent_spend_limits where agent = $1", [parent])).rows[0]; s.spend = row ? { usd: Number(row.usd), spent: Number(row.spent), setAt: Number(row.set_at) } : null; }
          return s.spend;
        },
        counted: (s: Session, cost: number) => { if (s.spend) s.spend.spent += cost; },
      },
    } as unknown as DelegationContext;
    return { session, ctx };
  };
  const spent = async () => Number((await db.query("select spent from agent_spend_limits where agent = $1", [parent])).rows[0].spent);
  const row = async () => (await db.query("select landed_by, state from agent_children where id = 'delegate_k'")).rows[0];
  return { db, parent, node, spent, row };
}

test("a call made again on a new node after its first node landed and was lost charges nothing more", async () => {
  const { node, spent, row } = await setup();
  const a = node(), b = node();
  // Node A takes the answer and lands it (charging the limit), then is lost before its tool result is written.
  assert.deepEqual(await landDelegate(a.ctx, "delegate_k", "completed", "call", { session: a.session, record }), { won: true, by: "call" });
  assert.equal(a.session.spend?.spent, COST, "A's own copy counts it");
  // Node B resumes the turn and makes the call again: it finds the row landed by a call, and charges nothing.
  assert.deepEqual(await landDelegate(b.ctx, "delegate_k", "completed", "call", { session: b.session, record }), { won: false, by: "call" });
  assert.equal(await spent(), COST);
  assert.equal(b.session.spend?.spent, COST, "B read the charge A wrote, and added nothing");
  assert.equal((await row()).landed_by, "call");
});

test("a parent node lost after the child ended but before it landed: the call made again on another node charges once", async () => {
  const { node, spent } = await setup();
  // Node A was lost while waiting: nothing landed, nothing charged. Node B makes the call again and lands it.
  const b = node();
  assert.equal((await landDelegate(b.ctx, "delegate_k", "completed", "call", { session: b.session, record })).won, true);
  assert.equal(await spent(), COST);
});

test("a stop racing the call's landing: one lands, and the spend is charged once", async () => {
  const { node, spent } = await setup();
  const call = node(), stop = node();
  const results = await Promise.all([
    landDelegate(call.ctx, "delegate_k", "completed", "call", { session: call.session, record }),
    landDelegate(stop.ctx, "delegate_k", "completed", "stop", { session: stop.session, record }),
  ]);
  assert.equal(results.filter(result => result.won).length, 1);
  assert.equal(await spent(), COST);
});

test("the late sweep racing the call's landing: one lands, and the spend is charged once", async () => {
  const { db, parent, node, spent, row } = await setup();
  // The parent's run is over (the sweep may land the row) and the child's run completed.
  const ctx = {
    db, state: { sweepingChildren: false }, isClosed: () => false, isDraining: () => false,
    options: { childSweepMs: 1, requestAnywhere: async (agent: string) => agent === parent ? { id: "run_1", state: "completed", status: "completed" } : record },
  } as unknown as ChildrenContext;
  const call = node();
  const [, landed] = await Promise.all([sweepChildren(ctx, Date.now()), landDelegate(call.ctx, "delegate_k", "completed", "call", { session: call.session, record })]);
  const by = (await row()).landed_by;
  assert.ok(by === "late" || by === "call", by);
  assert.equal(landed.won, by === "call");
  assert.equal(await spent(), COST);
  // And a sweep after the call landed charges nothing more.
  await db.query("update agent_children set state = 'running', checked_at = 0 where id = 'delegate_k'");
  await sweepChildren(ctx, Date.now());
  assert.equal(await spent(), COST);
});

test("a row an old node landed (charging it its own way) is never charged again by a new node", async () => {
  const { db, node, spent } = await setup();
  // An old node landed the call and wrote its in-memory charge with its next transcript record.
  await db.query("update agent_children set ended_at = 3, status = 'completed', state = 'notified', landed_at = 3, landed_by = 'call' where id = 'delegate_k'");
  await db.query("update agent_spend_limits set spent = spent + $1", [COST]);
  // A new node makes the call again (the old node lost), and so does a stop.
  const b = node(), stop = node();
  assert.deepEqual(await landDelegate(b.ctx, "delegate_k", "completed", "call", { session: b.session, record }), { won: false, by: "call" });
  assert.equal((await landDelegate(stop.ctx, "delegate_k", "completed", "stop", { session: stop.session, record })).won, false);
  assert.equal(await spent(), COST);
});
