import test from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, type DelegatedChild, type DelegationHost } from '../src/delegation.ts';
import { ChildOutbox, OUTBOX_PAGE, OUTBOX_RETRY, type ChildEnding, type ChildProgress } from '../src/ending-outbox.ts';
import { readFileSync } from 'node:fs';
import { withSql } from './sql-storage.ts';
import type { Owner } from '../../../shared/owner.ts';

// Durable endings: a child writes its ending to its own outbox and its alarm delivers it to the owner until the owner
// answers; the owner takes it once, however often it comes. Nothing on the owner's side polls.

function memory() {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async delete(key: string) { return values.delete(key); },
    async list({ prefix, limit }: { prefix: string; limit?: number }) { return new Map([...values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit ?? Infinity).map(([key, value]) => [key, structuredClone(value)])); },
    async transaction(work: (tx: unknown) => unknown) { return work(storage); },
  };
  withSql(storage);
  return { storage: storage as unknown as DurableObjectStorage, values };
}

const running: DelegatedChild = { id: 'child', key: 'delegate-1', requestId: 'delegate_1', parentRequestId: 'parent-run', toolCallId: 'call', name: 'helper', depth: 1, createdAt: 1, status: 'running', made: true, accepted: true, outbox: true };
const ending: ChildEnding = { agentId: 'child', requestId: 'delegate_1', record: { state: 'completed', status: 'completed', outcome: { result: { reply: 'done', usage: { costUsd: 0.15 } } } } };
const owner: Owner = { kind: 'agent', id: 'parent' };

function parent(store = memory()) {
  const events: any[] = [], tasks: Promise<unknown>[] = [];
  const host = { storage: store.storage, async emit(event: unknown) { events.push(event); }, async fetch() { assert.fail('the owner never asks its children'); }, waitUntil(promise: Promise<unknown>) { tasks.push(promise); } } as unknown as DelegationHost;
  return { store, events, tasks, host, delegation: new Delegation(host) };
}

test('an ending delivered twice is taken once: one charge, one subagent_end; an unknown run is refused', async () => {
  const p = parent();
  await p.delegation.rows.put(running);
  assert.deepEqual(await p.delegation.receiveEnding(ending), { accepted: true });
  assert.deepEqual(await p.delegation.receiveEnding(ending), { accepted: true });
  assert.equal(p.events.filter(event => event.event.type === 'subagent_end').length, 1);
  assert.equal(await p.delegation.cost('parent-run'), 0.15);
  assert.deepEqual(p.delegation.measurements, { endings: 1, repeatedEndings: 1, legacyRecovered: 0 });
  assert.equal((await p.delegation.rows.get(running.key))?.status, 'completed');
  assert.deepEqual(await p.delegation.receiveEnding({ ...ending, requestId: 'someone-else' }), { accepted: false });
  // No subagent_event relay: the parent's stream has the start and end of a child, never its events.
  assert.equal(p.events.some(event => event.event.type === 'subagent_event'), false);
});

test('the owner evicted while its child ran: a fresh instance takes the ending, and a wait on it returns', async () => {
  const store = memory(), before = parent(store);
  await before.delegation.rows.put(running);
  // The parent's object is gone (its in-memory waiters too); a delegate call replayed by Pi waits on a new instance.
  const after = parent(store);
  const waiting = after.delegation.wait(running);
  await after.delegation.receiveEnding(ending);
  assert.equal(after.delegation.answer(await waiting).text, 'done');
});

function child(deliver: { ending: (owner: Owner, ending: ChildEnding) => Promise<{ accepted: boolean }>; progress?: (owner: Owner, report: ChildProgress) => Promise<{ accepted: boolean; error?: string }> }, store = memory()) {
  let now = 1_000;
  const armed: number[] = [];
  const outbox = new ChildOutbox({ storage: store.storage, receiveEnding: deliver.ending, receiveProgress: deliver.progress ?? (async () => ({ accepted: true })), arm: async at => { armed.push(at); }, now: () => now, random: () => 0 });
  return { store, outbox, armed, advance: (ms: number) => { now += ms; } };
}

test('an ending staged but undelivered (the child lost before its alarm) is delivered by the next instance', async () => {
  const delivered: ChildEnding[] = [];
  const first = child({ ending: async () => { throw new Error('unreached'); } });
  await first.store.storage.transaction(async tx => first.outbox.stageEnding(tx as never, owner, ending));
  // Staged again (a repeated emit): still one row.
  await first.store.storage.transaction(async tx => first.outbox.stageEnding(tx as never, owner, ending));
  assert.equal(first.outbox.size(), 1);
  const next = child({ ending: async (_owner, value) => { delivered.push(value); return { accepted: true }; } }, first.store);
  assert.equal(await next.outbox.deadline(), 1_000);
  assert.equal(await next.outbox.flush(), undefined);
  assert.deepEqual(delivered, [ending]);
  assert.equal(next.outbox.size(), 0);
});

test('a failed delivery is retried with backoff until the owner answers, then the row goes', async () => {
  let failures = 3;
  const p = parent();
  await p.delegation.rows.put(running);
  const c = child({ ending: async (_owner, value) => { if (failures-- > 0) throw new Error('owner unavailable'); return p.delegation.receiveEnding(value); } });
  await c.store.storage.transaction(async tx => c.outbox.stageEnding(tx as never, owner, ending));
  const waits: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await c.outbox.flush();
    assert.ok(next !== undefined);
    waits.push(next - 1_000 - waits.reduce((sum, wait) => sum + wait, 0));
    c.advance(next - (1_000 + waits.slice(0, -1).reduce((sum, wait) => sum + wait, 0)));
    // Not due yet: nothing is sent early.
  }
  assert.deepEqual(waits, [OUTBOX_RETRY.firstMs, OUTBOX_RETRY.firstMs * 2, OUTBOX_RETRY.firstMs * 4]);
  assert.ok(c.armed.length >= 3, 'each failure arms the alarm');
  assert.equal(await c.outbox.flush(), undefined);
  assert.equal((await p.delegation.rows.get(running.key))?.status, 'completed');
  assert.equal(await c.outbox.deadline(), undefined);
});

test('progress: a refusal comes back to the call; an unreachable owner gets the report from the alarm', async () => {
  const report: ChildProgress = { agentId: 'child', requestId: 'delegate_1', text: 'half way', callId: 'p1' };
  const refused = child({ ending: async () => ({ accepted: true }), progress: async () => ({ accepted: false, error: 'Unknown sub-agent run' }) });
  assert.deepEqual(await refused.outbox.report(owner, report), { accepted: false, error: 'Unknown sub-agent run' });
  assert.equal(await refused.outbox.deadline(), undefined);
  let down = true;
  const reached: ChildProgress[] = [];
  const later = child({ ending: async () => ({ accepted: true }), progress: async (_owner, value) => { if (down) throw new Error('evicted'); reached.push(value); return { accepted: true }; } });
  assert.deepEqual(await later.outbox.report(owner, report), { accepted: true });
  down = false;
  later.advance(OUTBOX_RETRY.firstMs);
  await later.outbox.flush();
  assert.deepEqual(reached, [report]);
});

test('the owner records a delivered progress report once and refuses an unknown run without throwing', async () => {
  const p = parent();
  await p.delegation.rows.put(running);
  const report = { agentId: 'child', requestId: 'delegate_1', text: 'half way', callId: 'p1' };
  assert.deepEqual(await p.delegation.recordProgress(report), { accepted: true });
  assert.deepEqual(await p.delegation.recordProgress(report), { accepted: true });
  assert.equal(p.events.filter(event => event.event.type === 'subagent_progress').length, 1);
  assert.deepEqual(await p.delegation.recordProgress({ ...report, requestId: 'other' }), { accepted: false, error: 'Unknown sub-agent run' });
});

test('a paused child resumed and ended before its parent saw the resume: its ending makes the resume row and lands once', async () => {
  const p = parent();
  const paused = { ...running, key: 'spawn-1', requestId: 'spawn_1', background: true, status: 'input_required', endedAt: 2, notified: true, landedBy: 'notice' as const };
  await p.delegation.rows.put(paused);
  const { digest } = await import('../src/api-contract.ts');
  const resume = { agentId: 'child', requestId: `resume_${(await digest('spawn_1')).slice(0, 40)}`, record: { state: 'completed', status: 'completed', outcome: { result: { reply: 'resumed', usage: { costUsd: 0.05 } } } } };
  assert.deepEqual(await p.delegation.receiveEnding(resume), { accepted: true });
  assert.deepEqual(await p.delegation.receiveEnding(resume), { accepted: true });
  const row = await p.delegation.rows.get('spawn-1:resume');
  assert.equal(row?.status, 'completed');
  assert.equal(p.delegation.measurements.endings, 1);
  // Another child's resume, or one of a run that never paused, is not this parent's.
  assert.deepEqual(await p.delegation.receiveEnding({ ...resume, requestId: 'resume_other' }), { accepted: false });
});

test('a full page of rows none of which is due arms the alarm for the first one due, not now (no wake loop)', async () => {
  let failing = true;
  const c = child({ ending: async () => { if (failing) throw new Error('owner unavailable'); return { accepted: true }; } });
  for (let i = 0; i < OUTBOX_PAGE + 2; i++) await c.store.storage.transaction(async tx => c.outbox.stageEnding(tx, owner, { ...ending, requestId: `run_${String(i).padStart(4, '0')}` }));
  // Every delivery fails: each row is due again in a second.
  assert.equal(await c.outbox.flush(), 1_000, 'the rows past the page are due: the next flush is now');
  assert.equal(await c.outbox.flush(), 1_000 + OUTBOX_RETRY.firstMs, 'now all wait for their retry');
  c.armed.length = 0;
  // Nothing is due: a flush (as an alarm would run it) arms for the earliest retry, never for now.
  for (let i = 0; i < 3; i++) assert.equal(await c.outbox.flush(), 1_000 + OUTBOX_RETRY.firstMs);
  assert.ok(c.armed.every(at => at > 1_000), JSON.stringify(c.armed));
  failing = false;
  c.advance(OUTBOX_RETRY.firstMs);
  await c.outbox.flush();
  assert.equal(await c.outbox.flush(), undefined);
  assert.equal(c.outbox.size(), 0);
});

test('backoff has jitter: retries of rows that failed together spread out', async () => {
  const store = memory();
  let roll = 0;
  const armed: number[] = [];
  const outbox = new ChildOutbox({ storage: store.storage, receiveEnding: async () => { throw new Error('down'); }, receiveProgress: async () => ({ accepted: true }), arm: async at => { armed.push(at); }, now: () => 1_000, random: () => [0, 0.5, 1][roll++ % 3]! });
  for (const id of ['a', 'b', 'c']) await store.storage.transaction(async tx => outbox.stageEnding(tx, owner, { ...ending, requestId: id }));
  await outbox.flush();
  const retries = store.storage.sql.exec<{ next_at: number }>('SELECT next_at FROM child_outbox ORDER BY key').toArray().map(row => row.next_at - 1_000);
  assert.deepEqual(retries, [OUTBOX_RETRY.firstMs, OUTBOX_RETRY.firstMs * 1.1, OUTBOX_RETRY.firstMs * 1.2]);
});

test('a deleted (or expired) child keeps delivering its ending: its wakes flush the outbox and re-arm for the next retry', async () => {
  let reachable = false;
  const c = child({ ending: async () => { if (!reachable) throw new Error('owner evicted'); return { accepted: true }; } });
  await c.store.storage.transaction(async tx => c.outbox.stageEnding(tx, owner, { ...ending, record: { state: 'completed', status: 'aborted', error: 'The sub-agent was deleted' } }));
  const armed: (number | undefined)[] = [];
  const runtime = { outbox: c.outbox, arm: async () => { armed.push(await c.outbox.deadline()); } };
  // The deleted branch of the agent's wake runs exactly this (agent-lifecycle.ts).
  assert.match(readFileSync(new URL('../src/agent-lifecycle.ts', import.meta.url), 'utf8'), /if \(await this\.ctx\.storage\.get\("deleted"\)\) \{[^}]*ChildOutbox\.deletedWake\(this\)/);
  await ChildOutbox.deletedWake(runtime);
  assert.equal(c.outbox.size(), 1, 'the owner was unreachable: the row stays');
  assert.equal(armed[0], 1_000 + OUTBOX_RETRY.firstMs, 'and the alarm is armed for its retry');
  reachable = true;
  c.advance(OUTBOX_RETRY.firstMs * 2);
  await ChildOutbox.deletedWake(runtime);
  assert.equal(c.outbox.size(), 0);
  assert.equal(armed.at(-1), undefined, 'nothing left to wake for');
});

test('a deleted agent is never woken by its watchdog: an ended, unnotified child row (its notify refused, 410) arms nothing', async () => {
  const { deletedDeadline } = await import('../src/ending-outbox.ts');
  // The path the review found: the parent expired, its cancelled background child delivered its ending, the notify
  // threw 410 on the deleted agent's config, and the row stayed ended and unnotified ("recovering"). Deleted, the
  // agent's next wake is only what it owes.
  assert.equal(deletedDeadline({ billing: false, events: false, outbox: undefined }, 1_000), Infinity, 'nothing owed: no wake at all');
  assert.equal(deletedDeadline({ billing: false, events: false, outbox: 61_000 }, 1_000), 61_000, 'the outbox\'s next retry, not now + 1 s');
  assert.equal(deletedDeadline({ billing: true, events: false, outbox: 61_000 }, 1_000), 6_000);
  // armImpl takes this branch for a deleted agent before it computes recovering or its watchdog.
  const source = readFileSync(new URL('../src/agent-lifecycle.ts', import.meta.url), 'utf8');
  const arm = source.slice(source.indexOf('export async function armImpl'), source.indexOf('export async function onStartImpl'));
  assert.ok(arm.indexOf('if (deleted) {') > 0 && arm.indexOf('if (deleted) {') < arm.indexOf('const recovering'), 'the deleted branch comes before recovering');
  assert.match(arm.slice(arm.indexOf('if (deleted) {'), arm.indexOf('const records')), /deletedDeadline\([^)]*\)[\s\S]*return;/);
});

test('a flush arms the alarm once, however many rows failed', async () => {
  const c = child({ ending: async () => { throw new Error('owner unavailable'); } });
  for (let i = 0; i < 40; i++) await c.store.storage.transaction(async tx => c.outbox.stageEnding(tx, owner, { ...ending, requestId: `r${i}` }));
  c.armed.length = 0;
  await c.outbox.flush();
  assert.equal(c.armed.length, 1);
});

test('outbox rows an earlier build kept in KV move into the table and are delivered', async () => {
  const delivered: string[] = [];
  const c = child({ ending: async (_owner, value) => { delivered.push(value.requestId); return { accepted: true }; } });
  await c.store.storage.put('child-outbox:old_run:z', { kind: 'ending', owner, ending: { ...ending, requestId: 'old_run' }, attempts: 2, nextAt: 0, createdAt: 900 });
  await c.outbox.flush();
  assert.deepEqual(delivered, ['old_run']);
  assert.equal(c.store.values.has('child-outbox:old_run:z'), false);
});
