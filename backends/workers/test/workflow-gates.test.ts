import assert from "node:assert/strict";
import test from "node:test";
import { testDatabase } from "./billing-database.ts";
import { WorkflowGates, gateInputId, gateValue, GATE_PAUSED_ANSWERABLE_MS, type WorkflowGatesHost } from "../src/workflow-gates.ts";
import { Inputs } from "../src/decision-inputs.ts";
import type { EffectOutcome, StartedEffect } from "../src/workflow-runner.ts";

// A workflow's gate() as an inbox item the workflow owns: opened once per effect, answered once, landed once.

function storage() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string) { return structuredClone(map.get(key)) as T | undefined; },
    async put(key: string, value: unknown) { map.set(key, structuredClone(value)); },
    async delete(key: string) { return map.delete(key); },
    async list<T>(options: { prefix?: string } = {}) { return new Map([...map].filter(([key]) => key.startsWith(options.prefix ?? "")) as [string, T][]); },
  };
}

async function setup(workflow = { id: "wf_gates", tenant: "t1" }, audience: { approvers?: string[]; subject?: string } = {}) {
  const { db } = await testDatabase();
  const landed: { key: string; attempt: number; outcome: EffectOutcome }[] = [];
  const opened: { key: string; inputId: string; title: string; expiresAt: number }[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const store = storage();
  const host: WorkflowGatesHost = {
    workflow, db: () => db, storage: store as never,
    land: async (key, attempt, outcome) => { landed.push({ key, attempt, outcome }); },
    defer: task => { deferred.push(task); },
    audience: async () => audience,
    opened: gate => { opened.push(gate); },
  };
  const gates = new WorkflowGates(host);
  const drain = async () => { while (deferred.length) await deferred.shift()!(); };
  return { db, gates, landed, opened, store, drain, deferred, inputs: new Inputs({ db }) };
}
const effect = (overrides: Partial<StartedEffect> = {}): StartedEffect => ({
  key: "ship", attempt: 1, kind: "gate", args: { title: "Ship it?", options: ["ship", "hold"], recommended: "ship", reason: "Tests pass" },
  options: { expiresInSeconds: 3600, onExpire: "pause" }, phase: undefined, dueAt: Date.now() + 3_600_000, ...overrides,
});

test("a gate opens one inbox item the workflow owns, and its owner hears of it once", async () => {
  const { db, gates, opened, drain } = await setup();
  await gates.start(effect());
  await gates.start(effect()); // a restart starts it again
  await drain();
  const rows = (await db.query("select * from agent_inputs where owner_kind = 'workflow'")).rows;
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.id, gateInputId("wf_gates", "ship", 1));
  assert.deepEqual([row.owner_id, row.agent, row.tenant, row.kind, row.state, row.blocking], ["wf_gates", "wf_gates", "t1", "decision", "pending", false]);
  assert.equal(row.input.detail.title, "Ship it?");
  assert.deepEqual(row.input.detail.questions[0].options.map((option: { label: string }) => option.label), ["ship", "hold"]);
  assert.deepEqual(row.input.detail.recommendation.answer, { answers: { "Ship it?": "ship" } });
  assert.ok(Number(row.expires_at) > Date.now() + 3_500_000 && Number(row.expires_at) <= Date.now() + 3_600_000, "the item expires at the gate's deadline");
  assert.deepEqual(opened.map(gate => [gate.key, gate.inputId, gate.title]), [["ship", row.id, "Ship it?"]]);
  const events = (await db.query("select type from webhook_outbox where tenant = 't1'").catch(() => ({ rows: [] }))).rows;
  assert.ok(events.length === 0 || events.some((event: { type: string }) => event.type === "input.requested"));
});

test("an answer lands on the effect exactly once; the same answer again is `same`, a different one a conflict", async () => {
  const { gates, landed, drain, inputs } = await setup();
  await gates.start(effect());
  await drain();
  const id = gateInputId("wf_gates", "ship", 1);
  const [first] = await gates.answer([{ agent: "wf_gates", id, version: 1, action: "accept", content: "hold" }]);
  assert.equal(first!.outcome, "answered");
  assert.deepEqual(landed, [{ key: "ship", attempt: 1, outcome: { ok: true, value: "hold" } }]);
  const [again] = await gates.answer([{ agent: "wf_gates", id, version: 1, action: "accept", content: "hold" }]);
  assert.equal(again!.outcome, "same");
  const [other] = await gates.answer([{ agent: "wf_gates", id, version: 2, action: "accept", content: "ship" }]);
  assert.equal(other!.outcome, "conflict");
  assert.equal(landed.length, 1, "landed once");
  assert.equal((await inputs.get(id))!.state, "answered");
  // The recommendation, taken by name; and a decline gives the script null.
  const second = await setup({ id: "wf_two", tenant: "t1" });
  await second.gates.start(effect({ key: "a" }));
  await second.gates.start(effect({ key: "b" }));
  await second.drain();
  await second.gates.answer([{ agent: "wf_two", id: gateInputId("wf_two", "a", 1), version: 1, accept: "recommended" }]);
  await second.gates.answer([{ agent: "wf_two", id: gateInputId("wf_two", "b", 1), version: 1, action: "decline" }]);
  assert.deepEqual(second.landed.map(entry => [entry.key, entry.outcome]), [["a", { ok: true, value: "ship" }], ["b", { ok: true, value: null }]]);
});

test("another workflow's item, or one never asked, is unknown here", async () => {
  const { gates, drain } = await setup();
  await gates.start(effect());
  await drain();
  const other = await setup({ id: "wf_other", tenant: "t1" });
  const [outcome] = await other.gates.answer([{ agent: "wf_other", id: gateInputId("wf_gates", "ship", 1), version: 1, action: "accept", content: "ship" }]);
  assert.equal(outcome!.outcome, "unknown");
  assert.equal(other.landed.length, 0);
});

test("expiry: a gate that takes its recommendation leaves the inbox; one that pauses stays answerable, and its answer lands", async () => {
  const { gates, landed, drain, inputs } = await setup();
  const rec = effect({ key: "rec", options: { expiresInSeconds: 1, onExpire: "recommended" }, dueAt: Date.now() + 1000 });
  const pause = effect({ key: "pause", options: { expiresInSeconds: 1, onExpire: "pause" }, dueAt: Date.now() + 1000 });
  await gates.start(rec);
  await gates.start(pause);
  await drain();
  const later = Date.now() + 2_000;
  assert.equal(await gates.expire(rec, true, later), undefined, "nobody answered: the runner takes the recommendation");
  const recItem = (await inputs.get(gateInputId("wf_gates", "rec", 1)))!;
  assert.equal(recItem.state, "expired");
  assert.deepEqual(recItem.answer!.content, { answers: { "Ship it?": "ship" } }, "settled with the recommendation the runner takes");
  const [late] = await gates.answer([{ agent: "wf_gates", id: recItem.id, version: recItem.version, action: "accept", content: "hold" }]);
  assert.equal(late!.outcome, "conflict", "an answer after the deadline closed it is refused, never answered");
  assert.equal(await gates.expire(pause, false, later), undefined);
  const pausedId = gateInputId("wf_gates", "pause", 1);
  const paused = (await inputs.get(pausedId))!;
  assert.equal(paused.state, "pending");
  assert.equal(paused.version, 1, "what the person saw is still what they answer");
  assert.ok(paused.expiresAt >= later + GATE_PAUSED_ANSWERABLE_MS - 1000);
  assert.equal(landed.length, 0, "the runner decides the expiry; nothing is landed for it here");
  const [answered] = await gates.answer([{ agent: "wf_gates", id: pausedId, version: 1, action: "accept", content: "ship" }]);
  assert.equal(answered!.outcome, "answered");
  assert.deepEqual(landed, [{ key: "pause", attempt: 1, outcome: { ok: true, value: "ship" } }]);
});

test("the deadline race: an answer that settled the item first is what the runner lands, not the recommendation", async () => {
  const { gates, drain, inputs } = await setup();
  const gate = effect({ options: { expiresInSeconds: 60, onExpire: "recommended" } });
  await gates.start(gate);
  await drain();
  const id = gateInputId("wf_gates", "ship", 1);
  // The person's answer commits between the alarm firing and the gate closing.
  await inputs.settle(id, { action: "accept", content: { answers: { "Ship it?": "hold" } }, by: { via: "api" }, at: Date.now() });
  assert.deepEqual(await gates.expire(gate, true), { outcome: { ok: true, value: "hold" } });
  assert.equal((await inputs.get(id))!.state, "answered", "the expiry did not overwrite it");
  // And a pausing gate the same way.
  const other = await setup({ id: "wf_pause", tenant: "t1" });
  await other.gates.start(gate);
  await other.drain();
  await other.inputs.settle(gateInputId("wf_pause", "ship", 1), { action: "decline", by: { via: "api" }, at: Date.now() });
  assert.deepEqual(await other.gates.expire(gate, false), { outcome: { ok: true, value: null } });
});

test("approvers: as for the owner agent's own decisions, only they may answer, and the item is theirs in the inbox", async () => {
  const { gates, drain, db, landed } = await setup({ id: "wf_appr", tenant: "t1" }, { approvers: ["alice"], subject: "acme" });
  await gates.start(effect());
  await drain();
  const id = gateInputId("wf_appr", "ship", 1);
  const row = (await db.query("select responders, subject from agent_inputs where id = $1", [id])).rows[0];
  assert.deepEqual([row.responders, row.subject], [["alice"], "acme"]);
  const [nobody] = await gates.answer([{ agent: "wf_appr", id, version: 1, action: "accept", content: "ship" }]);
  assert.equal(nobody!.outcome, "invalid", "an answer naming no one is refused");
  const [bob] = await gates.answer([{ agent: "wf_appr", id, version: 1, action: "accept", content: "ship", actor: "bob" }]);
  assert.equal(bob!.outcome, "forbidden");
  assert.equal(landed.length, 0);
  const [alice] = await gates.answer([{ agent: "wf_appr", id, version: 1, action: "accept", content: "ship", actor: "alice" }]);
  assert.equal(alice!.outcome, "answered");
  assert.deepEqual(landed.map(entry => entry.outcome), [{ ok: true, value: "ship" }]);
});

test("an item the poll writes again expires at the gate's deadline; a paused gate's item, written at its deadline, stays answerable", async () => {
  const { gates, deferred, drain, inputs } = await setup();
  const due = Date.now() + 120_000;
  const gate = effect({ dueAt: due });
  await gates.start(gate);
  deferred.length = 0; // its write is lost
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await gates.poll(gate), undefined);
  await drain();
  const id = gateInputId("wf_gates", "ship", 1);
  assert.equal((await inputs.get(id))!.expiresAt, due, "the same deadline as the runner's, not the poll's clock");
  // A pausing gate whose item was never written by its deadline: written then, answerable.
  const lost = await setup({ id: "wf_lost", tenant: "t1" });
  await lost.gates.start(gate);
  lost.deferred.length = 0;
  const now = Date.now();
  assert.equal(await lost.gates.expire(gate, false, now), undefined);
  const item = (await lost.inputs.get(gateInputId("wf_lost", "ship", 1)))!;
  assert.equal(item.state, "pending");
  assert.ok(item.expiresAt >= now + GATE_PAUSED_ANSWERABLE_MS - 1000);
  // After the pause the runner has no deadline for it (due_at cleared): a poll's write uses the paused window.
  const fresh = await setup({ id: "wf_nodue", tenant: "t1" });
  const { dueAt: _dueAt, ...undated } = gate;
  await fresh.gates.start(undated);
  await fresh.drain();
  assert.ok((await fresh.inputs.get(gateInputId("wf_nodue", "ship", 1)))!.expiresAt >= Date.now() + GATE_PAUSED_ANSWERABLE_MS - 5000);
});

test("a landing lost after the item was answered lands on recovery, and the sweep's poll reads it", async () => {
  const { gates, landed, drain, inputs } = await setup();
  await gates.start(effect());
  await drain();
  const id = gateInputId("wf_gates", "ship", 1);
  await inputs.settle(id, { action: "accept", content: { answers: { "Ship it?": "ship" } }, by: { via: "api" }, at: Date.now() });
  assert.deepEqual(await gates.poll(effect()), { outcome: { ok: true, value: "ship" } });
  await gates.recover();
  await drain();
  assert.deepEqual(landed, [], "the poll forgot the gate: the runner records the poll's outcome itself");
  // An item never written (a crash between the start and its write) is written by the poll.
  const fresh = await setup({ id: "wf_crash", tenant: "t1" });
  await fresh.gates.start(effect());
  fresh.deferred.length = 0; // its write is lost
  assert.equal(await fresh.gates.poll(effect()), undefined);
  // The start's deferred write and the poll's are the same item, written once.
  await fresh.drain();
  assert.equal((await fresh.db.query("select count(*)::int as n from agent_inputs where owner_id = 'wf_crash'")).rows[0].n, 1);
  // Recovery after a restart lands an item answered while the workflow was evicted.
  await fresh.inputs.settle(gateInputId("wf_crash", "ship", 1), { action: "accept", content: { answers: { "Ship it?": "hold" } }, by: { via: "api" }, at: Date.now() });
  await fresh.gates.recover();
  await fresh.drain();
  assert.deepEqual(fresh.landed, [{ key: "ship", attempt: 1, outcome: { ok: true, value: "hold" } }]);
});

test("abort and cancel withdraw open gates; a gate the inbox cannot hold fails its effect", async () => {
  const { gates, drain, inputs, landed } = await setup();
  await gates.start(effect({ key: "a" }));
  await gates.start(effect({ key: "b" }));
  await drain();
  await gates.cancel(effect({ key: "a" }));
  assert.equal((await inputs.get(gateInputId("wf_gates", "a", 1)))!.state, "withdrawn");
  await gates.abort();
  assert.equal((await inputs.get(gateInputId("wf_gates", "b", 1)))!.state, "withdrawn");
  await gates.start(effect({ key: "bad", args: { title: "Pick", options: ["1", "2", "3", "4", "5"] } }));
  await drain();
  assert.equal(landed.length, 1);
  assert.equal(landed[0]!.outcome.ok, false);
  assert.match(String((landed[0]!.outcome as { error: string }).error), /^gate\(\): /);
  assert.deepEqual(gateValue({ detail: { title: "T" }, answer: { action: "accept", content: { answers: { T: ["a", "b"] } }, by: {}, at: 1 } }), ["a", "b"]);
});
