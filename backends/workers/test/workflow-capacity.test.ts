import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { CapacityLedger, tenantCaps, workflowCaps, WORKFLOW_CAPACITY, type TenantCaps } from "../src/workflow-capacity.ts";

// The object's module extends DurableObject: a stand-in that keeps ctx and env, as the runtime's does.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { WorkflowCapacity } = await import("../src/workflow-capacity-object.ts");
hooks.deregister();

function storage(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = { exec(query: string, ...args: any[]) {
    const statement = db.prepare(query);
    const rows = /^\s*(SELECT|WITH)/i.test(query) ? statement.all(...args) : (statement.run(...args), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1, query); return rows[0]; } };
  } } as unknown as SqlStorage;
  const atomic = <T>(write: () => T): T => {
    db.exec("SAVEPOINT w");
    try { const result = write(); db.exec("RELEASE w"); return result; }
    catch (error) { db.exec("ROLLBACK TO w"); db.exec("RELEASE w"); throw error; }
  };
  return { sql, atomic };
}

const CAPS: TenantCaps = { children: 4, workflows: 2 };

test("caps: defaults, the busy-agent tier bounds them, operator and tenant settings", () => {
  assert.deepEqual(tenantCaps({}, "t", { busyAgents: null }), { children: 256, workflows: 20 });
  assert.deepEqual(tenantCaps({}, "t", { busyAgents: 50 }), { children: 45, workflows: 20 }, "Free tier: 90% of 50 busy agents");
  assert.deepEqual(tenantCaps({}, "t", { busyAgents: 250 }), { children: 225, workflows: 20 }, "Tier 1 runs a 64-wide workflow");
  const env = { AGENT_WORKFLOW_LIMITS: JSON.stringify({ children: 100, workflows: 5 }), AGENT_WORKFLOW_TENANT_LIMITS: JSON.stringify({ big: { children: 2000 } }) };
  assert.deepEqual(tenantCaps(env, "t", { busyAgents: 4000 }), { children: 100, workflows: 5 });
  assert.deepEqual(tenantCaps(env, "big", { busyAgents: 1000 }), { children: 900, workflows: 5 }, "a tenant's own setting is still bounded by its tier");
  assert.throws(() => tenantCaps({ AGENT_WORKFLOW_LIMITS: '{"children":0}' }, "t", { busyAgents: null }), /positive whole number/);
  assert.throws(() => tenantCaps({ AGENT_WORKFLOW_TENANT_LIMITS: '{"t":{"gpus":1}}' }, "t", { busyAgents: null }), /unknown field gpus/);
  assert.deepEqual(workflowCaps({}, tenantCaps({}, "t", { busyAgents: null })), { concurrency: 16 });
  assert.deepEqual(workflowCaps({ concurrency: 64 }, { children: 45, workflows: 20 }), { concurrency: 45 });
  assert.throws(() => workflowCaps({ concurrency: 65 }, CAPS), /concurrency must be a whole number from 1 to 64/);
});

test("a workflow's own cap queues its extra requests; a release grants the next; acquire is idempotent by key", t => {
  const { sql, atomic } = storage(t);
  const ledger = new CapacityLedger(sql, atomic, () => 1_000);
  assert.deepEqual(ledger.open("w1", { concurrency: 2 }, CAPS).caps, { concurrency: 2 });
  const a = ledger.acquire("w1", "child", "impl:a").acquired, b = ledger.acquire("w1", "child", "impl:b").acquired;
  assert.ok(a.granted && b.granted);
  const c = ledger.acquire("w1", "child", "impl:c").acquired;
  assert.deepEqual(c.granted ? undefined : [c.reason, c.position], ["workflow_cap", 1]);
  const again = ledger.acquire("w1", "child", "impl:a").acquired;
  assert.ok(again.granted && a.granted && again.lease.id === a.lease.id, "a replayed step gets its slot back");
  assert.equal(ledger.acquire("w1", "child", "impl:c").acquired.granted, false, "and a waiting one its place");
  assert.equal(ledger.usage().tenant.children.waiting, 1);
  const grants = ledger.release("w1", a.granted ? a.lease.id : "");
  assert.deepEqual(grants.map(g => [g.workflow, g.kind, g.key]), [["w1", "child", "impl:c"]]);
  assert.deepEqual(ledger.release("w1", a.granted ? a.lease.id : ""), [], "releasing twice is a no-op");
  assert.throws(() => ledger.acquire("nope", "child", "x"), /not open/);
  assert.throws(() => ledger.acquire("w1", "gpu" as never, "x"), /kind is child/);
});

test("fair share: a workflow holding the tenant's capacity cannot starve another; spare capacity goes round robin", t => {
  const { sql, atomic } = storage(t);
  const ledger = new CapacityLedger(sql, atomic, () => 1_000);
  ledger.open("big", { concurrency: 16 }, CAPS);
  const held = ["a", "b", "c", "d"].map(key => ledger.acquire("big", "child", key).acquired);
  assert.ok(held.every(slot => slot.granted), "alone, a workflow may use the whole tenant cap");
  ledger.acquire("big", "child", "e");
  ledger.acquire("big", "child", "f");
  ledger.open("small", { concurrency: 16 }, CAPS);
  const first = ledger.acquire("small", "child", "x").acquired;
  assert.equal(first.granted ? "" : first.reason, "tenant_cap");
  ledger.acquire("small", "child", "y");
  ledger.acquire("small", "child", "z");
  const lease = (i: number) => { const slot = held[i]; assert.ok(slot.granted); return slot.lease.id; };
  // big holds 4, its share is 2 (4 slots, 2 workflows): freed slots go to small, though big asked first.
  assert.deepEqual(ledger.release("big", lease(0)).map(g => `${g.workflow}:${g.key}`), ["small:x"]);
  assert.deepEqual(ledger.release("big", lease(1)).map(g => `${g.workflow}:${g.key}`), ["small:y"]);
  // Both at their share: the one granted longest ago goes next (big), then small.
  assert.deepEqual(ledger.release("big", lease(2)).map(g => `${g.workflow}:${g.key}`), ["big:e"]);
  assert.deepEqual(ledger.usage().workflows.map(w => [w.workflow, w.children.held, w.children.waiting]), [["big", 2, 1], ["small", 2, 1]]);
  // When small ends, big takes the whole cap again.
  const grants = ledger.close("small");
  assert.deepEqual(grants.map(g => `${g.workflow}:${g.key}`), ["big:f"]);
  assert.equal(ledger.usage().tenant.children.held, 3);
});

test("running workflows per tenant: the next is refused until one ends; reopening keeps slots and moves caps", t => {
  const { sql, atomic } = storage(t);
  const ledger = new CapacityLedger(sql, atomic, () => 1_000);
  ledger.open("w1", {}, CAPS);
  ledger.open("w2", {}, CAPS);
  assert.throws(() => ledger.open("w3", {}, CAPS), (error: any) => error.code === "workflow_limit" && /as many as it may at once \(2\)/.test(error.message));
  assert.ok(ledger.acquire("w1", "child", "k").acquired.granted);
  assert.deepEqual(ledger.open("w1", { concurrency: 1 }, CAPS).caps.concurrency, 1, "a restarted workflow opens again");
  assert.equal(ledger.usage("w1").workflows[0].children.held, 1);
  ledger.close("w2");
  ledger.open("w3", {}, CAPS);
  assert.equal(ledger.usage().tenant.workflows, 2);
});

test("leases: a workflow that stops renewing loses its slots to waiters; renew keeps them; expiry is never now", t => {
  const { sql, atomic } = storage(t);
  const clock = { now: 1_000 };
  const ledger = new CapacityLedger(sql, atomic, () => clock.now);
  ledger.open("crashed", { concurrency: 16 }, { ...CAPS, children: 2 });
  ledger.open("alive", { concurrency: 16 }, { ...CAPS, children: 2 });
  ledger.acquire("crashed", "child", "a");
  ledger.acquire("crashed", "child", "b");
  const waiting = ledger.acquire("alive", "child", "x").acquired;
  assert.equal(waiting.granted, false);
  assert.equal(ledger.nextExpiry(), 1_000 + WORKFLOW_CAPACITY.leaseMs);
  clock.now += WORKFLOW_CAPACITY.leaseMs - 1_000;
  const renewed = ledger.renew("alive");
  assert.deepEqual([renewed.held.length, renewed.waiting.length], [0, 1]);
  clock.now += 1_000;
  assert.deepEqual(ledger.expire().map(g => `${g.workflow}:${g.key}`), ["alive:x"], "the crashed workflow's slots go to the waiter");
  assert.equal(ledger.usage().tenant.workflows, 1);
  assert.ok(ledger.nextExpiry()! > clock.now);
  assert.throws(() => ledger.renew("crashed"), /open it again/);
  // A release or close never grants a waiter whose workflow has already expired, even before any alarm ran.
  clock.now = 10 * WORKFLOW_CAPACITY.leaseMs;
  ledger.open("alive", { concurrency: 16 }, { ...CAPS, children: 2 });
  assert.ok(ledger.acquire("alive", "child", "y").acquired.granted && ledger.acquire("alive", "child", "z").acquired.granted, "alive holds the whole cap");
  ledger.open("ghost", { concurrency: 16 }, { ...CAPS, children: 2 });
  assert.equal(ledger.acquire("ghost", "child", "g").acquired.granted, false);
  clock.now += WORKFLOW_CAPACITY.leaseMs - 1;
  const held = ledger.renew("alive").held[0];
  clock.now += 2;
  assert.deepEqual(ledger.release("alive", held.id), [], "the ghost expired: its request is not granted");
  assert.equal(ledger.usage("ghost").workflows.length, 0);
  // An overdue row the clock has passed is reported due after now, never at or before it.
  clock.now += WORKFLOW_CAPACITY.leaseMs * 2;
  assert.equal(ledger.nextExpiry(), clock.now + 1);
  ledger.expire();
  assert.equal(ledger.nextExpiry(), undefined, "nothing left, no alarm");
});

function capacityObject(t: { after(fn: () => void): void }, env: Record<string, unknown> = {}) {
  const { sql, atomic } = storage(t);
  const alarms: number[] = [];
  let alarm: number | null = null;
  const background: Promise<unknown>[] = [];
  const ctx = {
    id: { name: "tenant-1" },
    storage: { sql, transactionSync: atomic, getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; alarms.push(at); }, deleteAlarm: async () => { alarm = null; } },
    waitUntil: (promise: Promise<unknown>) => { background.push(promise); },
  };
  const object = new WorkflowCapacity(ctx as never, env as never);
  return { object, alarms, alarm: () => alarm, background };
}

test("the object wakes a waiting workflow on release and on expiry, and never arms its alarm for now", async t => {
  const woken: [string, string, string[]][] = [];
  const WORKFLOWS = { getByName: (workflow: string) => ({ capacityGranted: async (tenant: string, grants: { key: string }[]) => { woken.push([workflow, tenant, grants.map(g => g.key)]); } }) };
  const { object, alarms, alarm, background } = capacityObject(t, { WORKFLOWS, AGENT_WORKFLOW_LIMITS: JSON.stringify({ children: 1 }) });
  assert.equal((await object.open("w1", {}, { busyAgents: 250 })).ok, true);
  assert.equal((await object.open("w2", {}, { busyAgents: 250 })).ok, true);
  const first = await object.acquire("w1", "child", "a");
  assert.ok(first.ok && first.granted);
  const second = await object.acquire("w2", "child", "b");
  assert.ok(second.ok && !second.granted && second.reason === "tenant_cap");
  await object.release("w1", first.lease.id);
  await Promise.all(background);
  assert.deepEqual(woken, [["w2", "tenant-1", ["b"]]], "the waiter is told by the release, with no polling");
  const refused = await object.acquire("w9", "child", "x");
  assert.deepEqual(refused.ok ? undefined : refused.code, "workflow_not_open", "a refusal comes back as a value over RPC");
  const limit = await object.open("w3", {}, { busyAgents: 250 });
  assert.ok(limit.ok);
  const usage = await object.usage();
  assert.equal(usage.tenant.children.held, 1);
  // Every alarm it set was in the future when set.
  assert.ok(alarms.length > 0);
  assert.ok(alarms.every(at => at > Date.now() - 5_000 + 1));
  // The alarm fires: nothing has expired, so it re-arms at the next expiry and wakes no one.
  const before = woken.length;
  await object.alarm();
  assert.ok(alarm()! > Date.now());
  assert.equal(woken.length, before);
  // Closing every workflow leaves nothing to expire: no alarm.
  for (const workflow of ["w1", "w2", "w3"]) await object.close(workflow);
  assert.equal(alarm(), null);
});

test("without a WORKFLOWS binding grants still happen and are read on renew", async t => {
  const { object } = capacityObject(t, { AGENT_WORKFLOW_LIMITS: JSON.stringify({ children: 1 }) });
  await object.open("w1", {}, { busyAgents: null });
  await object.open("w2", {}, { busyAgents: null });
  const first = await object.acquire("w1", "child", "a");
  assert.ok(first.ok && first.granted);
  await object.acquire("w2", "child", "b");
  await object.release("w1", first.lease.id);
  const renewed = await object.renew("w2");
  assert.ok(renewed.ok);
  assert.deepEqual(renewed.held.map(lease => lease.key), ["b"]);
});
