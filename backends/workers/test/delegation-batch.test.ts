import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DelegationNotifications, type NotificationHost } from '../src/delegation-notifications.ts';
import { Delegation, type DelegatedChild } from '../src/delegation.ts';
import { renderMessage } from '../src/sender.ts';
import { withSql } from './sql-storage.ts';

// Batched completions (multi-agent.ts BatchedEnding): when one child's notice lands, every other ended child's notice
// still in the outbox rides in the same turn. Exactly once: no ending is lost or delivered twice, whatever crashes.

/** DO storage with real transactions: a transaction's writes commit together, or not at all when it throws. */
function atomic() {
  let values = new Map<string, unknown>();
  const ops = (map: Map<string, unknown>) => ({
    async get(key: string) { return structuredClone(map.get(key)); },
    async put(key: string, value: unknown) { map.set(key, structuredClone(value)); },
    async delete(key: string) { return map.delete(key); },
    async list({ prefix }: { prefix: string }) { return new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, structuredClone(value)])); },
  });
  const failures: ((key: string, value: any) => boolean)[] = [];
  const storage = {
    ...ops(values),
    async put(key: string, value: unknown) { if (failures.some(fail => fail(key, value))) throw new Error(`crash writing ${key}`); values.set(key, structuredClone(value)); },
    async transaction<T>(work: (tx: unknown) => Promise<T>) {
      const copy = new Map([...values].map(([key, value]) => [key, structuredClone(value)]));
      const tx = { ...ops(copy), async put(key: string, value: unknown) { if (failures.some(fail => fail(key, value))) throw new Error(`crash writing ${key}`); copy.set(key, structuredClone(value)); } };
      const result = await work(tx);
      values = copy;
      storage.get = ops(values).get; storage.list = ops(values).list; storage.delete = ops(values).delete;
      return result;
    },
  };
  withSql(storage);
  return { storage: storage as unknown as DurableObjectStorage, get values() { return values; }, failures };
}

const ended = (key: string, name: string, reply: string, costUsd: number): DelegatedChild => ({
  id: `client_${key}`, key, requestId: `spawn_${key}`, parentRequestId: 'parent-run', toolCallId: `call_${key}`, task: 't', name, depth: 1, root: 'root',
  background: true, createdAt: 1_000, endedAt: 21_000, status: 'completed', made: true, accepted: true,
  outcome: { result: { reply, usage: { responses: 3, input: 1000, output: 100, costUsd } } },
});

function fixture() {
  const store = atomic();
  const submissions: { request: any; notice: any }[] = [], discarded: { id: string; skipped?: string }[] = [], staged: string[] = [];
  let busy = true, submitFails = 0;
  const host: NotificationHost = {
    storage: store.storage,
    canLand: async () => !busy,
    async stage(request) { staged.push(request.id); },
    async discard(request, skipped) { discarded.push({ id: request.id, skipped }); },
    async submit(request, notice) {
      if (submitFails > 0) { submitFails--; throw new Error('node lost before the request was admitted'); }
      submissions.push({ request: structuredClone(request), notice: structuredClone(notice) });
    },
    async admitWake() { return { allowed: true, hour: 0 }; },
    async retry() {},
  };
  return {
    store, host, submissions, discarded, staged,
    land: () => { busy = false; },
    failSubmits: (n: number) => { submitFails = n; },
    async child(value: DelegatedChild) { await store.storage.put(`delegation:${value.key}`, value); return value; },
    notifications: () => new DelegationNotifications(host),
  };
}
/** Every child ending the parent heard of, through its own notice or carried in another's: each exactly once. */
function heard(submissions: { request: any; notice: any }[]) {
  const ids = new Set<string>(), all: string[] = [];
  for (const { request, notice } of submissions) {
    if (ids.has(request.id)) continue; // the same request sent again is deduplicated by admission (its id)
    ids.add(request.id);
    all.push(request.id, ...(notice.metadata.batch ?? []).map((ending: any) => ending.requestId));
  }
  return all.sort();
}

test('endings that wait behind a busy parent land in one turn: one request carries them all, each heard once', async () => {
  const f = fixture();
  const a = await f.child(ended('a', 'mul', 'PR 1', 0.02)), b = await f.child(ended('b', 'cap', 'PR 2', 0.03)), c = await f.child(ended('c', 'doc', 'PR 3', 0.01));
  for (const child of [a, b, c]) await f.notifications().deliver(child);
  assert.equal(f.submissions.length, 0, 'the parent is busy: all three are staged');
  assert.deepEqual(f.staged.sort(), ['child_spawn_a', 'child_spawn_b', 'child_spawn_c']);
  f.land();
  await f.notifications().drain();
  assert.equal(f.submissions.length, 1, 'one turn');
  const [{ request, notice }] = f.submissions;
  assert.equal(request.id, 'child_spawn_a');
  assert.deepEqual(notice.metadata.batch.map((ending: any) => [ending.requestId, ending.name, ending.text, ending.costUsd]), [['child_spawn_b', 'cap', 'PR 2', 0.03], ['child_spawn_c', 'doc', 'PR 3', 0.01]]);
  assert.equal(notice.costUsd, 0.02, "the landing notice's own cost; carried ones are charged each (landNotice)");
  // The carried ones never send, their staged copies are answered as carried, and a later drain changes nothing.
  // (A carried one's own send discards again, which the host makes a no-op: crash safety for the claim's discard.)
  assert.deepEqual([...new Set(f.discarded.map(entry => entry.id))].sort(), ['child_spawn_b', 'child_spawn_c']);
  assert.match(f.discarded[0].skipped!, /with another one's notification/);
  await f.notifications().drain();
  for (const child of [b, c]) await f.notifications().deliver(child);
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(heard(f.submissions), ['child_spawn_a', 'child_spawn_b', 'child_spawn_c']);
  for (const key of ['a', 'b', 'c']) assert.equal((f.store.values.get(`delegation:${key}`) as DelegatedChild).landedBy, 'notice');
  // As the model reads it: a block per sub-agent, each with what its run took.
  const text = (renderMessage({ role: 'user', content: request.params.text, timestamp: 0, source: notice.source, metadata: notice.metadata } as any) as any).content[0].text as string;
  assert.equal(text.match(/<agent_notification name="/g)?.length, 3);
  assert.match(text, /<agent_notification name="cap" status="completed" took="20s" model_calls="3" tool_calls="0" tokens="1.1k" cost_usd="0.030">\nPR 2\n<\/agent_notification>/);
});

test('a crash between the claim and the send sends the same batch again, and nothing else', async () => {
  const f = fixture();
  const a = await f.child(ended('a', 'mul', 'PR 1', 0.02)), b = await f.child(ended('b', 'cap', 'PR 2', 0.03));
  for (const child of [a, b]) await f.notifications().deliver(child);
  f.land();
  f.failSubmits(1);
  await assert.rejects(f.notifications().drain(), /node lost/);
  assert.equal(f.submissions.length, 0);
  assert.equal((f.store.values.get('delegation-notice:b') as any).batchedInto, 'delegation-notice:a', 'claimed into a before the send');
  // A new instance (the DO restarted) drains: a goes with the batch it stored, b is not sent on its own, and b's staged
  // copy is discarded by that drain alone (not by a later delivery of b's own).
  await f.notifications().drain();
  assert.ok(f.discarded.some(entry => entry.id === 'child_spawn_b'), 'b staged copy discarded on the resend');
  await f.notifications().deliver(b);
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.submissions[0].notice.metadata.batch.map((ending: any) => ending.requestId), ['child_spawn_b']);
  assert.deepEqual(heard(f.submissions), ['child_spawn_a', 'child_spawn_b']);
});

test('a crash inside the claim leaves nothing claimed: the next drain batches as if it never ran', async () => {
  const f = fixture();
  const a = await f.child(ended('a', 'mul', 'PR 1', 0.02)), b = await f.child(ended('b', 'cap', 'PR 2', 0.03));
  for (const child of [a, b]) await f.notifications().deliver(child);
  f.land();
  const fail = (key: string, value: any) => key === 'delegation-notice:b' && value?.batchedInto !== undefined;
  f.store.failures.push(fail);
  await assert.rejects(f.notifications().drain(), /crash writing delegation-notice:b/);
  assert.equal((f.store.values.get('delegation:a') as DelegatedChild).landedBy, undefined, 'the claim rolled back whole');
  assert.equal((f.store.values.get('delegation-notice:b') as any).delivered, undefined);
  f.store.failures.length = 0;
  await f.notifications().drain();
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(heard(f.submissions), ['child_spawn_a', 'child_spawn_b']);
});

test('a crash after the send, before its receipt, repeats the identical request: the batch is not heard twice', async () => {
  const f = fixture();
  const a = await f.child(ended('a', 'mul', 'PR 1', 0.02)), b = await f.child(ended('b', 'cap', 'PR 2', 0.03));
  for (const child of [a, b]) await f.notifications().deliver(child);
  f.land();
  f.store.failures.push((key, value) => key === 'delegation-notice:a' && value?.delivered === true);
  await assert.rejects(f.notifications().drain(), /crash writing delegation-notice:a/);
  f.store.failures.length = 0;
  await f.notifications().drain();
  assert.equal(f.submissions.length, 2, 'sent again');
  assert.deepEqual(f.submissions[0], f.submissions[1], 'byte for byte the same request, which admission deduplicates by id');
  assert.deepEqual(heard(f.submissions), ['child_spawn_a', 'child_spawn_b']);
});

test('only ended endings still in the outbox ride: not one a wait_agent took, a running child, a message, or one bound to land without a turn', async () => {
  const f = fixture();
  const a = await f.child(ended('a', 'mul', 'PR 1', 0.02));
  const waited = await f.child({ ...ended('b', 'cap', 'PR 2', 0.03), landedBy: 'wait' });
  const running = await f.child({ ...ended('c', 'doc', 'x', 0), status: 'running' });
  for (const child of [a, waited, running]) await f.notifications().deliver(child);
  await f.notifications().deliverMessage({ id: 'msg_1', method: 'prompt', params: { text: 'hi', allowDisconnected: true, whileRunning: 'followUp' } },
    { source: { kind: 'agent', agentId: 'client_d', name: 'd' } as any, root: 'root', costUsd: 0, metadata: { kind: 'message' } });
  await f.child(ended('e', 'late', 'PR 5', 0.01));
  await f.notifications().deliver(ended('e', 'late', 'PR 5', 0.01));
  await f.notifications().abortPending();
  f.land();
  await f.notifications().drain();
  const sent = f.submissions.find(entry => entry.request.id === 'child_spawn_a');
  assert.deepEqual(sent?.notice.metadata.batch ?? [], [], 'nothing eligible rode with it');
});

test("landing a batch charges each carried child its own cost, once, to the run it starts", async () => {
  const store = atomic();
  const a = ended('a', 'mul', 'PR 1', 0.02), b = ended('b', 'cap', 'PR 2', 0.03);
  for (const child of [a, b]) await store.storage.put(`delegation:${child.key}`, child);
  const delegation = new Delegation({ storage: store.storage } as any);
  const batch = [{ requestId: 'child_spawn_b', costUsd: 0.03 }];
  await delegation.landNotice('child_spawn_a', 0.02, batch);
  await delegation.landNotice('child_spawn_a', 0.02, batch); // admitted again after a crash
  assert.equal(await delegation.cost('child_spawn_a'), 0.05);
  for (const key of ['a', 'b']) assert.equal((store.values.get(`delegation:${key}`) as DelegatedChild).charged, true);
});

test('a sibling that ended but has no outbox entry yet (its events still draining) is carried, and its own delivery sends nothing', async () => {
  const f = fixture();
  f.land();
  const a = await f.child(ended('a', 'mul', 'PR 1', 0.02)), b = await f.child(ended('b', 'cap', 'PR 2', 0.03));
  await f.notifications().deliver(a);
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.submissions[0].notice.metadata.batch.map((ending: any) => [ending.requestId, ending.text, ending.costUsd]), [['child_spawn_b', 'PR 2', 0.03]]);
  assert.equal((f.store.values.get('delegation-notice:b') as any).batchedInto, 'delegation-notice:a', 'its entry was written with the batch, already carried');
  await f.notifications().deliver(b);
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(heard(f.submissions), ['child_spawn_a', 'child_spawn_b']);
});

// Repros from #725's review (each failed before its fix).
function plainMemory() {
  const values = new Map<string, unknown>();
  const ops = { async get(k: string) { return structuredClone(values.get(k)); }, async put(k: string, v: unknown) { values.set(k, structuredClone(v)); },
    async delete(k: string) { return values.delete(k); }, async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); } };
  return withSql({ ...ops, async transaction(work: any) { return work(ops); }, values });
}
const reviewEnded = (key: string, extra: any = {}) => ({ id: `client_${key}`, key, requestId: `spawn_${key}`, parentRequestId: 'p', toolCallId: `call_${key}`, task: 't', name: key, depth: 1, root: 'root',
  background: true, createdAt: 1, endedAt: 2, status: 'completed', made: true, accepted: true, outcome: { result: { reply: 'r', usage: { responses: 1, input: 1, output: 1, costUsd: 0.01 } } }, ...extra });

test('review #725: a crash in the discard loop after the claim still discards the carried staged copy', async () => {
  const storage = plainMemory(); let busy = true, failDiscard = 1; const staged = new Set<string>(); const submissions: any[] = [];
  const host: NotificationHost = { storage: storage as any, canLand: async () => !busy, async stage(r) { staged.add(r.id); },
    async discard(r) { if (failDiscard-- > 0) throw new Error('crash'); staged.delete(r.id); },
    async submit(r, n) { submissions.push(n); staged.delete(r.id); /* admission turns a staged copy into the request itself */ }, async admitWake() { return { allowed: true, hour: 0 }; }, async retry() {} };
  for (const k of ['a', 'b']) await storage.put(`delegation:${k}`, reviewEnded(k));
  for (const k of ['a', 'b']) await new DelegationNotifications(host).deliver(reviewEnded(k) as any);
  busy = false;
  await assert.rejects(new DelegationNotifications(host).drain());
  await new DelegationNotifications(host).drain();
  assert.equal(submissions.length, 1);
  assert.deepEqual([...staged], [], 'b staged copy still pending');
});

test('review #725: a notice carried while its own send awaits canLand is not left staged', async () => {
  const storage = plainMemory(); let busy = false; const staged = new Set<string>(); const submissions: any[] = [];
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let first = true;
  const host: NotificationHost = { storage: storage as any,
    canLand: async () => { if (first) { first = false; await gate; } return !busy; },
    async stage(r) { staged.add(r.id); }, async discard(r) { staged.delete(r.id); },
    async submit(r, n) { submissions.push(n); busy = true; }, async admitWake() { return { allowed: true, hour: 0 }; }, async retry() {} };
  for (const k of ['a', 'b']) await storage.put(`delegation:${k}`, reviewEnded(k));
  const n = new DelegationNotifications(host);
  const pb = n.deliver(reviewEnded('b') as any);
  await new Promise(r => setTimeout(r, 5));
  await n.deliver(reviewEnded('a') as any);
  release(); await pb;
  assert.equal(submissions.length, 1);
  assert.deepEqual([...staged], [], 'b staged after being carried, never discarded');
});

test('review #725: a background child whose start failed (never accepted, no outbox entry) is not carried', async () => {
  const storage = plainMemory(); const submissions: any[] = [];
  const host: NotificationHost = { storage: storage as any, canLand: async () => true, async submit(r, n) { submissions.push(n); }, async admitWake() { return { allowed: true, hour: 0 }; }, async retry() {} };
  await storage.put('delegation:a', reviewEnded('a'));
  await storage.put('delegation:f', reviewEnded('f', { status: 'failed', accepted: false, error: 'Child failed', outcome: undefined }));
  await new DelegationNotifications(host).deliver(reviewEnded('a') as any);
  assert.deepEqual(submissions[0].metadata.batch ?? [], [], 'failed start (its error was the spawn tool result) carried');
});

// delegate.notify "asap": a busy parent's child ending joins its running turn (a steer) unless a wait_agent is in flight.
function asapFixture(asap: () => boolean) {
  const f = fixture();
  const deliveries: unknown[] = [];
  const submit = f.host.submit;
  f.host.submit = async (request, notice, delivery) => { deliveries.push(structuredClone(delivery)); return submit(request, notice, delivery); };
  f.host.asap = async () => asap();
  return { ...f, deliveries };
}

test('asap: an ending reaching a busy parent is sent at once as a steer, with the endings it carries; a crash resends it identically', async () => {
  const f = asapFixture(() => true);
  const b = await f.child(ended('b', 'cap', 'PR 2', 0.03)), a = await f.child(ended('a', 'mul', 'PR 1', 0.02));
  f.store.failures.push((key, value) => key === 'delegation-notice:a' && value?.delivered === true);
  await assert.rejects(f.notifications().deliver(a), /crash writing/);
  f.store.failures.length = 0;
  await f.notifications().drain();
  assert.deepEqual(f.staged, [], 'not staged behind the turn');
  assert.equal(f.submissions.length, 2);
  assert.deepEqual(f.submissions[0], f.submissions[1], 'the same request again');
  assert.deepEqual(f.deliveries, [{ run: true, steer: true }, { run: true, steer: true }]);
  assert.deepEqual(f.submissions[0].notice.metadata.batch.map((ending: any) => ending.requestId), ['child_spawn_b']);
  await f.notifications().deliver(b);
  assert.deepEqual(heard(f.submissions), ['child_spawn_a', 'child_spawn_b']);
});

test('asap: with a wait_agent in flight the ending is staged for the wait, and stays staged once it is (decided once)', async () => {
  let waiting = true;
  const f = asapFixture(() => !waiting);
  const a = await f.child(ended('a', 'mul', 'PR 1', 0.02));
  await f.notifications().deliver(a);
  assert.deepEqual(f.staged, ['child_spawn_a']);
  waiting = false;
  await f.notifications().drain();
  assert.equal(f.submissions.length, 0, 'still waiting for the turn to end, as staged');
  f.land();
  await f.notifications().drain();
  assert.deepEqual(f.deliveries, [{ run: true }], 'queued, as its staged request was');
});

test('the default (notify "turn") never steers: a busy parent stages the ending until its turn ends', async () => {
  const f = fixture();
  const a = await f.child(ended('a', 'mul', 'PR 1', 0.02));
  await f.notifications().deliver(a);
  assert.deepEqual(f.staged, ['child_spawn_a']);
  assert.equal(f.submissions.length, 0);
});


test('notification batches never combine different task payers or buckets', async () => {
  const f = fixture();
  const a = await f.child({ ...ended('a', 'one', 'a', 0.01), payer: 'guest', bucket: 'bot:1' });
  const b = await f.child({ ...ended('b', 'two', 'b', 0.01), payer: 'other', bucket: 'bot:1' });
  const c = await f.child({ ...ended('c', 'three', 'c', 0.01), payer: 'guest', bucket: 'bot:2' });
  for (const child of [a, b, c]) await f.notifications().deliver(child);
  f.land();
  await f.notifications().drain();
  assert.equal(f.submissions.length, 3);
  for (const { notice } of f.submissions) assert.deepEqual(notice.metadata.batch ?? [], []);
});
