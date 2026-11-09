import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionTranscripts, type TranscriptStore } from '../shared/session-transcripts.ts';

test('transcript cursor visits every child, retains indexes, and applies a half-open window', async () => {
  const calls: unknown[][] = [];
  const store: TranscriptStore = {
    async query(_sql, values) { calls.push(values); return { rows: ['a', 'b'].filter(id => id >= String(values[3])).slice(0, 1).map(id => ({id})) }; },
    async page(agent, after) { return {entries: [{index: after, message: {role: 'user', timestamp: agent === 'a' ? 10 + after : 20}}], total: agent === 'a' ? 2 : 1, nextAfter: after + 1}; }
  };
  let cursor: string | undefined; const entries: any[] = [];
  for (let n = 0; n < 5; n++) {
    const page = await sessionTranscripts(store, 'tenant', 'a', {from: 10, to: 20, cursor});
    entries.push(...page.entries);
    if (!page.next) break;
    cursor = page.next;
  }
  assert.deepEqual(entries.map(e => e.index), [0, 1]);
  assert.ok(calls.every(c => c[0] === 'a' && c[1] === 'tenant'));
  await assert.rejects(sessionTranscripts(store, 'tenant', 'b', {from: 10, to: 20, cursor}), /cursor/);
  await assert.rejects(sessionTranscripts(store, 'tenant', 'a', {from: 10, to: 10}), /from/);
});
