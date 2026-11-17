import assert from "node:assert/strict";
import test from "node:test";
import { CompactionTask, InboxDoc, LiveDoc, type EntryId } from "@earendil-works/pi-durable";
import type { AgentRuntime } from "../src/agent-runtime.ts";
import { IDLE_COMPACTION_INSTRUCTIONS, IDLE_COMPACTION_KEY, IdleCompactionDoc, idleCompactionDeadline, idleCompactionWindow, wakeIdleCompaction, type IdleCompactionCandidate } from "../src/idle-compaction-schedule.ts";

function fixture() {
  const candidate: IdleCompactionCandidate = {
    at: 1_000, ...idleCompactionWindow(1_000, 300_000), cutoff: 8 as EntryId, tail: 10 as EntryId, revision: 1,
  };
  const configuration = { revision: 1, config: {} as { idleCompaction?: boolean }, expiresAt: null };
  const kv = new Map<string, unknown>([[IDLE_COMPACTION_KEY, candidate], ["configuration", configuration]]);
  const live: { compactions?: { taskId: number }[] } = {};
  const inbox = { items: [] as unknown[] };
  const claim: { tail?: number; taskId?: number } = {};
  const state = { latestEntry: candidate.tail, writesFail: false };
  const env: { AGENT_IDLE_COMPACTION?: string } = {};
  const tasks: unknown[][] = [];
  const conversation = {
    id: 1,
    commit: async (action: (tx: unknown) => unknown) => action({
      doc: async (doc: unknown) => doc === LiveDoc ? live : doc === InboxDoc ? inbox : doc === IdleCompactionDoc ? claim : assert.fail("Unexpected document"),
      latestEntryId: async () => state.latestEntry,
      createTask: async (...args: unknown[]) => { tasks.push(args); return 17; },
    }),
  };
  const access = {
    get: async (key: string) => kv.get(key),
    delete: async (key: string) => kv.delete(key),
    put: async (key: string, value: unknown) => kv.set(key, value),
  };
  const storage = {
    ...access,
    transaction: async (action: (tx: typeof access) => unknown) => {
      if (state.writesFail) throw new Error("KV unavailable");
      return action(access);
    },
  };
  const runtime = {
    env, ctx: { storage }, admission: Promise.resolve(), gone: async () => false, records: async () => [],
    harness: { pi: async () => ({ root: async () => conversation }) },
  } as unknown as AgentRuntime;
  return { runtime, env, kv, candidate, configuration, state, inbox, tasks };
}

test("short and long cache windows leave time for the alarm and provider preflight", () => {
  assert.deepEqual(idleCompactionWindow(1_000, 300_000), { dueAt: 241_000, expiresAt: 301_000 });
  assert.deepEqual(idleCompactionWindow(1_000, 3_600_000), { dueAt: 3_241_000, expiresAt: 3_601_000 });
});

test("idle compaction waits until due and stops scheduling new work when disabled or expired", async t => {
  const f = fixture();
  let now = f.candidate.dueAt - 1;
  t.mock.method(Date, "now", () => now);
  assert.equal(await idleCompactionDeadline(f.runtime), f.candidate.dueAt);
  await wakeIdleCompaction(f.runtime);
  assert.equal(f.tasks.length, 0);
  assert.equal(f.kv.get(IDLE_COMPACTION_KEY), f.candidate);

  now = f.candidate.expiresAt;
  f.env.AGENT_IDLE_COMPACTION = "0";
  assert.equal(await idleCompactionDeadline(f.runtime), Infinity);
  await wakeIdleCompaction(f.runtime);
  assert.equal(f.kv.get(IDLE_COMPACTION_KEY), f.candidate);

  delete f.env.AGENT_IDLE_COMPACTION;
  await wakeIdleCompaction(f.runtime);
  assert.equal(f.kv.has(IDLE_COMPACTION_KEY), false);
  assert.equal(f.tasks.length, 0);
});

test("an alarm arriving just before expiry leaves the old context in place", async t => {
  const f = fixture();
  t.mock.method(Date, "now", () => f.candidate.expiresAt - 5_000);
  await wakeIdleCompaction(f.runtime);
  assert.equal(f.tasks.length, 0);
  assert.equal(f.kv.has(IDLE_COMPACTION_KEY), false);
});

test("an agent's opt-out and subsequent opt-in cannot revive an old candidate", async t => {
  const f = fixture();
  t.mock.method(Date, "now", () => f.candidate.dueAt);
  f.configuration.config.idleCompaction = false;
  f.configuration.revision++;
  assert.equal(await idleCompactionDeadline(f.runtime), Infinity);
  await wakeIdleCompaction(f.runtime);
  f.configuration.config.idleCompaction = true;
  f.configuration.revision++;
  assert.equal(await idleCompactionDeadline(f.runtime), Infinity);
  await wakeIdleCompaction(f.runtime);
  assert.equal(f.tasks.length, 0);
});

test("a compaction already committed in Pi is recovered after updating the alarm's record fails", async t => {
  const f = fixture();
  t.mock.method(Date, "now", () => f.candidate.dueAt);
  f.state.writesFail = true;
  await assert.rejects(wakeIdleCompaction(f.runtime), /KV unavailable/);
  assert.deepEqual(f.tasks, [[CompactionTask, {
    reason: "threshold", instructions: `${IDLE_COMPACTION_INSTRUCTIONS}:${f.candidate.tail}`,
  }, { ownership: { kind: "conversation" }, conversationId: 1, background: true }]]);

  f.state.writesFail = false;
  await wakeIdleCompaction(f.runtime);
  assert.equal(f.tasks.length, 1);
  assert.deepEqual(f.kv.get(IDLE_COMPACTION_KEY), { ...f.candidate, taskId: 17 });
  assert.equal(await idleCompactionDeadline(f.runtime), f.candidate.expiresAt);
});

test("pending Pi inputs or a newer journal tail invalidate an idle compaction candidate", async t => {
  for (const changed of ["inbox", "tail"]) await t.test(changed, async t => {
    const f = fixture();
    t.mock.method(Date, "now", () => f.candidate.dueAt);
    if (changed === "inbox") f.inbox.items.push({ submissionId: 1 });
    else f.state.latestEntry = 11 as EntryId;
    await wakeIdleCompaction(f.runtime);
    assert.equal(f.tasks.length, 0);
    assert.equal(f.kv.has(IDLE_COMPACTION_KEY), false);
  });
});
