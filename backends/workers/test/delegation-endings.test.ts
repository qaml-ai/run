import test from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, type DelegatedChild, type DelegationHost } from '../src/delegation.ts';
import { ChildOutbox, OUTBOX_PREFIX, OUTBOX_RETRY, type ChildEnding, type ChildProgress } from '../src/ending-outbox.ts';
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
  const outbox = new ChildOutbox({ storage: store.storage, receiveEnding: deliver.ending, receiveProgress: deliver.progress ?? (async () => ({ accepted: true })), arm: async at => { armed.push(at); }, now: () => now });
  return { store, outbox, armed, advance: (ms: number) => { now += ms; } };
}

test('an ending staged but undelivered (the child lost before its alarm) is delivered by the next instance', async () => {
  const delivered: ChildEnding[] = [];
  const first = child({ ending: async () => { throw new Error('unreached'); } });
  await first.store.storage.transaction(async tx => first.outbox.stageEnding(tx as never, owner, ending));
  // Staged again (a repeated emit): still one row.
  await first.store.storage.transaction(async tx => first.outbox.stageEnding(tx as never, owner, ending));
  assert.equal([...first.store.values.keys()].filter(key => key.startsWith(OUTBOX_PREFIX)).length, 1);
  const next = child({ ending: async (_owner, value) => { delivered.push(value); return { accepted: true }; } }, first.store);
  assert.equal(await next.outbox.deadline(), 1_000);
  assert.equal(await next.outbox.flush(), undefined);
  assert.deepEqual(delivered, [ending]);
  assert.equal([...first.store.values.keys()].filter(key => key.startsWith(OUTBOX_PREFIX)).length, 0);
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
