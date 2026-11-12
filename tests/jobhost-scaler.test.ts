import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: plain ESM for the Lambda runtime, no types
import { plan } from "../infra/job-hosts/scaler/plan.mjs";

const NOW = 10_000_000, IDLE = 10 * 60_000;
const group = (over: Record<string, unknown> = {}) => ({ name: "camelrun-job-hosts-test", min: 0, max: 16, desired: 0, slots: 8, instances: [] as { id: string; state: string }[], ...over });
const host = (id: string, over: Record<string, unknown> = {}) => ({ host: id, slots: 8, running: 0, draining: false, idleSince: null as number | null, ...over });
const demand = (pools: Record<string, unknown>) => ({ at: NOW, pools });
const run = (d: unknown, groups: Record<string, unknown>) => plan(d, groups, { now: NOW, idleMs: IDLE });

test("a cold pool with waiting jobs grows by the hosts they need, up to its maximum", () => {
  assert.deepEqual(run(demand({ test: { hosts: [], running: 0, waiting: 3 } }), { test: group() }),
    [{ type: "desired", pool: "test", group: "camelrun-job-hosts-test", desired: 1, from: 0 }]);
  assert.deepEqual(run(demand({ test: { hosts: [], running: 0, waiting: 20 } }), { test: group() })[0].desired, 3);
  assert.deepEqual(run(demand({ test: { hosts: [], running: 0, waiting: 500 } }), { test: group() })[0].desired, 16, "never past the maximum");
  // A build host takes one job: one host per waiting build job.
  assert.deepEqual(run(demand({ build: { hosts: [], running: 0, waiting: 2 } }), { build: group({ name: "b", max: 4, slots: 1 }) })[0].desired, 2);
});

test("hosts still booting count as capacity: no second scale-out for the same waiting jobs", () => {
  const booting = group({ desired: 1, instances: [{ id: "i-0000000000000000a", state: "Pending" }] });
  assert.deepEqual(run(demand({ test: { hosts: [], running: 0, waiting: 3 } }), { test: booting }), []);
  // More waiting than the booting host will take: one more.
  assert.deepEqual(run(demand({ test: { hosts: [], running: 0, waiting: 12 } }), { test: booting })[0].desired, 2);
});

test("busy live hosts with room take the waiting jobs themselves; a full pool grows", () => {
  const live = group({ desired: 1, instances: [{ id: "i-0000000000000000a", state: "InService" }] });
  assert.deepEqual(run(demand({ test: { hosts: [host("i-0000000000000000a", { running: 5 })], running: 5, waiting: 2 } }), { test: live }), []);
  assert.deepEqual(run(demand({ test: { hosts: [host("i-0000000000000000a", { running: 8 })], running: 8, waiting: 1 } }), { test: live })[0].desired, 2);
});

test("an idle host is drained one minute and ended the next, never below the minimum, never while jobs wait", () => {
  const instances = [{ id: "i-0000000000000000a", state: "InService" }, { id: "i-0000000000000000b", state: "InService" }];
  const idle = (draining: boolean) => host("i-0000000000000000a", { idleSince: NOW - IDLE, draining });
  const recent = host("i-0000000000000000b", { idleSince: NOW - 60_000 });
  assert.deepEqual(run(demand({ test: { hosts: [idle(false), recent], running: 0, waiting: 0 } }), { test: group({ desired: 2, instances }) }),
    [{ type: "drain", pool: "test", host: "i-0000000000000000a" }]);
  assert.deepEqual(run(demand({ test: { hosts: [idle(true), recent], running: 0, waiting: 0 } }), { test: group({ desired: 2, instances }) }),
    [{ type: "terminate", pool: "test", group: "camelrun-job-hosts-test", instance: "i-0000000000000000a" }]);
  // At the minimum (a warm build pool), idle hosts stay.
  assert.deepEqual(run(demand({ test: { hosts: [idle(false), recent], running: 0, waiting: 0 } }), { test: group({ desired: 2, min: 2, instances }) }), []);
  // A busy host is never ended, however long ago it was last idle.
  assert.deepEqual(run(demand({ test: { hosts: [host("i-0000000000000000a", { running: 1, idleSince: null, draining: true })], running: 1, waiting: 0 } }), { test: group({ desired: 1, instances: instances.slice(0, 1) }) }), []);
});

test("a host the group is terminating is drained, and its hook completed once it runs nothing or has gone", () => {
  const ending = group({ desired: 1, instances: [{ id: "i-0000000000000000a", state: "Terminating:Wait" }] });
  assert.deepEqual(run(demand({ test: { hosts: [host("i-0000000000000000a", { running: 2 })], running: 2, waiting: 0 } }), { test: ending }),
    [{ type: "drain", pool: "test", host: "i-0000000000000000a" }]);
  assert.deepEqual(run(demand({ test: { hosts: [host("i-0000000000000000a", { running: 0, draining: true })], running: 0, waiting: 0 } }), { test: ending }),
    [{ type: "complete", pool: "test", group: "camelrun-job-hosts-test", instance: "i-0000000000000000a" }]);
  assert.deepEqual(run(demand({ test: { hosts: [], running: 0, waiting: 0 } }), { test: ending }),
    [{ type: "complete", pool: "test", group: "camelrun-job-hosts-test", instance: "i-0000000000000000a" }], "gone: completed at once");
});

test("a pool with no group does nothing; a host not in the group is never ended", () => {
  assert.deepEqual(run(demand({ build: { hosts: [], running: 0, waiting: 5 } }), { build: undefined }), []);
  const stranger = host("i-00000000000000ffff", { idleSince: NOW - IDLE, draining: true });
  assert.deepEqual(run(demand({ test: { hosts: [stranger], running: 0, waiting: 0 } }), { test: group({ desired: 1, instances: [{ id: "i-0000000000000000a", state: "InService" }] }) }), []);
});

test("a terminating host that blips keeps its hook: completed only once gone five minutes, or idle and already draining", () => {
  const ending = group({ desired: 1, instances: [{ id: "i-0000000000000000a", state: "Terminating:Wait" }] });
  // Missed a few heartbeats (gone a minute): wait.
  assert.deepEqual(run(demand({ test: { hosts: [], gone: [{ host: "i-0000000000000000a", lastSeenAt: NOW - 60_000 }], running: 0, waiting: 0 } }), { test: ending }), []);
  // Gone five minutes: complete.
  assert.deepEqual(run(demand({ test: { hosts: [], gone: [{ host: "i-0000000000000000a", lastSeenAt: NOW - 5 * 60_000 }], running: 0, waiting: 0 } }), { test: ending }),
    [{ type: "complete", pool: "test", group: "camelrun-job-hosts-test", instance: "i-0000000000000000a" }]);
  // Idle but not yet draining when read: drained this minute, completed the next.
  assert.deepEqual(run(demand({ test: { hosts: [host("i-0000000000000000a")], running: 0, waiting: 0 } }), { test: ending }),
    [{ type: "drain", pool: "test", host: "i-0000000000000000a" }]);
});

test("a drain is never one-way: jobs waiting undrain a host still in service, and count it again before growing", () => {
  const live = group({ desired: 1, instances: [{ id: "i-0000000000000000a", state: "InService" }] });
  const drained = host("i-0000000000000000a", { draining: true, idleSince: NOW - 60_000 });
  assert.deepEqual(run(demand({ test: { hosts: [drained], running: 0, waiting: 2 } }), { test: live }),
    [{ type: "undrain", pool: "test", host: "i-0000000000000000a" }], "its 8 slots take the 2 waiting jobs: no new host");
  // A draining host the group is terminating is not undrained.
  const ending = group({ desired: 1, instances: [{ id: "i-0000000000000000a", state: "Terminating:Wait" }] });
  assert.ok(!run(demand({ test: { hosts: [host("i-0000000000000000a", { draining: true, running: 1 })], running: 1, waiting: 2 } }), { test: ending }).some((action: { type: string }) => action.type === "undrain"));
});
