import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.ts';
const CHILDREN = 64;

// Run against real workerd, including SQL, all child DOs, model transport and Pi.
test('workerd runs 64 concurrent delegated children without relay streams or per-child polling', { timeout: 240_000 }, async t => {
  // Local workerd does not impose the hosted isolate's memory budget. Force
  // normal V8 GC under a conservative old-space budget; no forced collections.
  const priorFlags = process.env.MINIFLARE_WORKERD_V8_FLAGS;
  process.env.MINIFLARE_WORKERD_V8_FLAGS = '--max-old-space-size=96 --max-semi-space-size=2';
  t.after(() => { if (priorFlags === undefined) delete process.env.MINIFLARE_WORKERD_V8_FLAGS; else process.env.MINIFLARE_WORKERD_V8_FLAGS = priorFlags; });
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  let started = 0, active = 0, peakChildren = 0;
  const provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const child = body.messages.some((message: any) => JSON.stringify(message.content).includes('LOAD_CHILD'));
    let delta: object;
    if (child) {
      started++; peakChildren = Math.max(peakChildren, ++active);
      await gate.promise; active--;
      delta = { role: 'assistant', content: 'child-complete' };
    } else if (body.messages.some((message: any) => message.role === 'tool')) delta = { role: 'assistant', content: 'all-64-complete' };
    else delta = { role: 'assistant', tool_calls: Array.from({ length: CHILDREN }, (_, index) => ({ index, id: `load-${index}`, type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ instructions: `LOAD_CHILD ${index}`, task: 'Complete the load test' }) } })) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'load', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'load', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => { provider.closeAllConnections(); return new Promise<void>(resolve => provider.close(() => resolve())); });
  const fixture = await startFixture({ modelURL: `http://127.0.0.1:${(provider.address() as any).port}/v1`, entrypoint: fileURLToPath(new URL('./delegation-load-entry.ts', import.meta.url)), vars: { TEST_MODE: '1' } });
  t.after(() => fixture.stop());
  fixture.worker.logLimit = 1_000_000;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.url + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const raw = await response.text();
    assert.ok(response.headers.get('content-type')?.includes('json'), `${path}: ${response.status} ${raw} ${fixture.worker.logs()}`);
    const value = JSON.parse(raw);
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)} ${fixture.worker.logs()}`); return value;
  };
  const parent = await call('/v1/agents', { codeMode: false, fileTools: false, builtins: ['delegate'], delegate: { instructions: true, maxParallel: 64 } });
  const sampler = await fixture.worker.heapSampler();
  const baseline = await sampler.read();
  const footprint = (heap: Record<string, number>) => heap.usedSize + (heap.embedderHeapUsedSize ?? 0) + (heap.backingStorageSize ?? 0);
  let peakHeap = footprint(baseline);
  let peakBreakdown = baseline;
  let sampling = true;
  const samples = (async () => { while (sampling) { const heap = await sampler.read(); if (footprint(heap) > peakHeap) { peakHeap = footprint(heap); peakBreakdown = heap; } await new Promise(resolve => setTimeout(resolve, 250)); } })();
  const began = Date.now();
  void samples.catch(() => {});
  const run = await call(`/v1/agents/${parent.id}/prompt`, { text: 'Start all children' });
  try {
    const startupDeadline = Date.now() + 90_000;
    while (started < CHILDREN && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(started, CHILDREN, fixture.worker.logs());
    assert.equal(peakChildren, CHILDREN);
    console.log('DELEGATION_LOAD_STARTED ' + JSON.stringify({ children: started, elapsedMs: Date.now() - began }));
    // Hold the children a while: the parent polls none of them meanwhile (their endings come by their outboxes).
    await new Promise(resolve => setTimeout(resolve, 5500));
    gate.resolve();
    const completionDeadline = Date.now() + 90_000;
    let record: any;
    do { record = await call(`/v1/agents/${parent.id}/requests/${run.id}`); if (record.state === 'completed') break; await new Promise(resolve => setTimeout(resolve, 250)); } while (Date.now() < completionDeadline);
    assert.equal(record.outcome?.result?.reply, 'all-64-complete', JSON.stringify(record));
    const profile = await call(`/__test/delegation/${parent.id}`);
    assert.equal(profile.children.length, CHILDREN);
    assert.ok(profile.childStateBytes < 128 * 1024, JSON.stringify(profile));
    const memoryLogs = fixture.worker.logs().split('\n').filter(line => line.startsWith('{"type":"delegation_memory"')).map(line => JSON.parse(line));
    assert.ok(memoryLogs.some(row => row.childCount === CHILDREN && row.heapEstimateBytes > 0), JSON.stringify(memoryLogs));
    assert.ok(memoryLogs.every(row => row.childCount > 32 && row.estimateScope === 'parent_delegation_bookkeeping'));
    console.log('DELEGATION_MEMORY ' + JSON.stringify(memoryLogs.at(-1)));
    assert.ok(profile.children.every((status: string) => status === 'completed'), JSON.stringify(profile));
    assert.equal(profile.eventStreams, 0);
    assert.ok(profile.rpc.total < 1000, JSON.stringify(profile.rpc));
    // Every ending reached the parent through its child's outbox, taken once; nothing was reconciled by polling.
    assert.equal(profile.endings, CHILDREN, JSON.stringify(profile));
    assert.equal(profile.legacyRecovered, 0, JSON.stringify(profile));
    await new Promise(resolve => setTimeout(resolve, 6000));
    const settled = await call(`/__test/delegation/${parent.id}`);
    assert.equal(settled.endings, profile.endings, 'nothing is taken again after completion');
    assert.equal(settled.alarmFires, profile.alarmFires, 'no alarm loop after completion');
    assert.ok(settled.alarmFires <= 2, JSON.stringify(settled));
    console.log('DELEGATION_LOAD ' + JSON.stringify({ concurrentChildren: peakChildren, v8Flags: process.env.MINIFLARE_WORKERD_V8_FLAGS, elapsedMs: Date.now() - began, baselineHeap: baseline, peakHeap: peakBreakdown, peakHeapBytes: peakHeap, ...settled }));
    assert.ok(peakHeap < 128 * 1024 * 1024, `heap ${peakHeap}`);

  } finally { sampling = false; gate.resolve(); await samples; sampler.close(); }
});
