import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepChildren, type ChildrenContext } from "../src/client-sessions/children.ts";
import { expireInputs, type InputContext } from "../src/client-sessions/inputs.ts";
import { agentGone } from "../src/agent-gone.ts";
import { decisionDetail, Inputs } from "../src/inputs.ts";
import { HttpError } from "../src/http.ts";
import type { Db } from "../src/db.ts";
import { testDatabase } from "./database.ts";

// A delivery to an agent Postgres records as deleted, purged or expired is dropped (once, with one log line), never
// retried; one to an agent that is merely busy, waiting or failing for now is kept and retried.

type Liveness = "live" | "revoked" | "expired" | "purged" | "missing";
async function agentRow(db: Db, id: string, liveness: Liveness) {
  if (liveness === "missing") return;
  await db.query("insert into agents (id, tenant, header, revision, name, type, model, revoked, expires_at, purged_at) values ($1, 't', '{}', 1, 'a', 'general', 'm', $2, $3, $4)",
    [id, liveness === "revoked" || liveness === "purged", liveness === "expired" ? Date.now() - 1_000 : null, liveness === "purged" ? Date.now() : null]);
}

/** Capture the structured lines `work` logs as errors. */
async function logged(work: () => Promise<unknown>) {
  const lines: any[] = [];
  const original = console.error;
  console.error = (line: unknown) => { try { lines.push(JSON.parse(String(line))); } catch { lines.push(line); } };
  try { await work(); } finally { console.error = original; }
  return lines;
}

test("agentGone counts only a durable deletion, purge or expiry", async () => {
  const { db } = await testDatabase();
  for (const liveness of ["live", "revoked", "expired", "purged"] as const) await agentRow(db, `client_${liveness}`, liveness);
  await db.query("update agents set expires_at = $2 where id = $1", ["client_live", Date.now() + 60_000]);
  assert.equal(await agentGone(db, "client_live"), false);
  assert.equal(await agentGone(db, "client_revoked"), true);
  assert.equal(await agentGone(db, "client_expired"), true);
  assert.equal(await agentGone(db, "client_purged"), true);
  assert.equal(await agentGone(db, "client_missing"), false, "a row that may not be committed yet is not gone");
  assert.equal(await agentGone(db, "client_missing", { missing: true }), true);
  assert.equal(await agentGone(db, "client_expired", { expiry: false }), false, "expiry need not count");
  assert.equal(await agentGone(db, "client_revoked", { expiry: false }), true);
});

/** A background child's ended row whose parent waits on a person (a blocking input pending). */
async function childEndingSetup(parentLiveness: Liveness) {
  const { db } = await testDatabase();
  const parent = `client_parent_${parentLiveness}`;
  await agentRow(db, parent, parentLiveness);
  const notice = { text: "done", notice: { source: { kind: "agent", agentId: "client_child", name: "worker-1" }, root: parent, costUsd: 0, metadata: { status: "completed" } } };
  await db.query(`insert into agent_children (id, tenant, parent, child, request_id, name, depth, root, parent_run, tool_call_id, kind, made, checked_at, created_at, updated_at, ended_at, status, notice)
    values ('spawn_k', 't', $1, 'client_child', 'spawn_k', 'worker-1', 1, $1, 'run_1', 'call_1', 'spawn', true, 0, 2, 2, 3, 'completed', $2)`, [parent, JSON.stringify(notice)]);
  const submitted: string[] = [];
  const ctx = { db, state: { sweepingChildren: false }, isClosed: () => false, isDraining: () => false,
    options: { childSweepMs: 1, inputs: { pending: async () => [{ blocking: true }] }, submit: async (agent: string) => { submitted.push(agent); return {}; } } } as unknown as ChildrenContext;
  const row = async () => (await db.query("select state, claimed_until from agent_children where id = 'spawn_k'")).rows[0];
  return { ctx, row, submitted, parent };
}

for (const liveness of ["revoked", "purged", "missing"] as const) {
  test(`a child's ending for a ${liveness} parent that waits on a person is dropped, not retried each sweep`, async () => {
    const { ctx, row, submitted, parent } = await childEndingSetup(liveness);
    const lines = await logged(() => sweepChildren(ctx, Date.now()));
    assert.equal((await row()).state, "notified");
    assert.deepEqual(submitted, []);
    assert.deepEqual(lines.filter(line => line?.type === "delivery_dropped_agent_gone"), [{ type: "delivery_dropped_agent_gone", delivery: "child_ending", agent: parent, child: "client_child", request: "spawn_k" }]);
    // Nothing is left for a later sweep.
    assert.deepEqual(await logged(() => sweepChildren(ctx, Date.now() + 60_000)), []);
  });
}

for (const liveness of ["live", "expired"] as const) test(`a child's ending for a ${liveness} parent that waits on a person waits for it (the row is released for the next sweep): Postgres's expiry can lag a live parent`, async () => {
  const { ctx, row, submitted } = await childEndingSetup(liveness);
  const lines = await logged(() => sweepChildren(ctx, Date.now()));
  const after = await row();
  assert.equal(after.state, "running");
  assert.equal(after.claimed_until, null);
  assert.deepEqual(submitted, []);
  assert.deepEqual(lines, []);
});

/** A non-blocking decision of `agent`'s, answered: its answers staged for delivery to the agent. */
async function decisionSetup(liveness: Liveness, failure: () => Error) {
  const { db } = await testDatabase();
  const agent = `client_asker_${liveness}`;
  await agentRow(db, agent, liveness);
  const store = new Inputs({ db });
  const detail = decisionDetail({ title: "Region?", body: "Pick a region", options: [{ label: "EU" }, { label: "US" }] });
  const [input] = await store.create({ agent, tenant: "t", requestId: "r1", toolCallId: "call1", tool: "request_decision", argumentsHash: "hash", responders: {}, expiresAt: Date.now() + 60_000, blocking: false, itemKey: "region" } as any,
    [{ kind: "question", message: "Region?", detail }]);
  await store.settleAll([{ id: input.id, answer: { action: "accept", content: { answers: { "Region?": "EU" } }, by: { actor: "person" }, at: Date.now() } }]);
  assert.equal((await store.deliveries(agent)).size, 1);
  let attempts = 0;
  const ctx = { options: { inputs: store, submit: async () => { attempts++; throw failure(); } } } as unknown as InputContext;
  return { store, ctx, agent, attempts: () => attempts };
}

for (const liveness of ["revoked", "expired", "purged", "missing"] as const) {
  test(`decision answers for a ${liveness} agent are dropped once, not sent again every scan`, async () => {
    const { store, ctx, agent, attempts } = await decisionSetup(liveness, () => new HttpError(liveness === "revoked" ? 410 : 404, "Unknown agent"));
    const lines = await logged(() => expireInputs(ctx));
    assert.equal(attempts(), 1);
    assert.equal((await store.deliveries(agent)).size, 0);
    const dropped = lines.filter(line => line?.type === "delivery_dropped_agent_gone");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].delivery, "decision_answers");
    assert.equal(dropped[0].agent, agent);
    assert.ok(!lines.some(line => line?.type === "decision_delivery_failed"));
    await expireInputs(ctx);
    assert.equal(attempts(), 1, "nothing is sent again");
  });
}

for (const [name, failure] of [["a 404 from a live agent's node", () => new HttpError(404, "Unknown client route")], ["a transient 503", () => new HttpError(503, "retry")], ["a network error", () => new Error("socket hang up")]] as const) {
  test(`decision answers that fail with ${name} for a live agent are kept and retried`, async () => {
    const { store, ctx, agent, attempts } = await decisionSetup("live", failure);
    const lines = await logged(() => expireInputs(ctx));
    assert.equal((await store.deliveries(agent)).size, 1);
    assert.ok(lines.some(line => line?.type === "decision_delivery_failed"));
    assert.ok(!lines.some(line => line?.type === "delivery_dropped_agent_gone"));
    await logged(() => expireInputs(ctx));
    assert.equal(attempts(), 2, "the next scan tries again");
  });
}
