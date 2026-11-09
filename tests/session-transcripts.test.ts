import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionTranscripts, type TranscriptStore } from '../shared/session-transcripts.ts';

test('transcript cursor visits every child, retains indexes, and applies a half-open window', async () => {
  const calls: unknown[][] = [];
  const store: TranscriptStore = {
    async query(_sql, values) { calls.push(values); return { rows: ['a', 'b'].map(id => ({id})) }; },
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

test('end-user filter attributes replies to their request and is bound into the cursor',async()=>{
  const store:TranscriptStore={query:async()=>({rows:[{id:'agent'}]}),scope:async()=>({requests:[{id:'a',began:10,endedAt:19,endUser:'alice',state:'completed'},{id:'b',began:20,endedAt:29,endUser:'bob',state:'completed'}]}),
    page:async()=>({entries:[{index:0,message:{requestId:'a',timestamp:10,content:'Alice'}},{index:1,message:{timestamp:15,content:'Alice reply'}},{index:2,message:{requestId:'b',timestamp:20,content:'Bob'}},{index:3,message:{timestamp:25,content:'Bob reply'}}],total:4,nextAfter:4})};
  const page=await sessionTranscripts(store,'tenant','agent',{from:0,to:30,endUser:'alice'});
  assert.deepEqual(page.entries.map(entry=>entry.index),[0,1]);
  await assert.rejects(sessionTranscripts(store,'tenant','agent',{from:0,to:30,endUser:'bob',cursor:page.next!}),/cursor/);
});
