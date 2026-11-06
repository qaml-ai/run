import test from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, type DelegatedChild, type DelegationHost } from '../src/delegation.ts';

test('child event relay uses WebSocket, preserves event order and drains before closing', async () => {
  const child = { id: 'child', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'call' } as DelegatedChild;
  const forwarded: any[] = [], waiting: Promise<unknown>[] = [];
  let closed = false;
  const socket = Object.assign(new EventTarget(), {
    accept() { queueMicrotask(() => send({ event: 'ready', data: {} })); },
    close() { closed = true; },
  });
  const send = (frame: object) => socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) }));
  const host = {
    async fetch(id: string, request: Request) {
      assert.equal(id, child.id);
      assert.equal(request.headers.get('Upgrade'), 'websocket');
      assert.equal(new URL(request.url).searchParams.get('subagents'), '1');
      return { status: 101, webSocket: socket } as unknown as Response;
    },
    waitUntil(work: Promise<unknown>) { waiting.push(work); },
    async emit(event: unknown) {
      await new Promise(resolve => setTimeout(resolve, 1));
      forwarded.push(event);
    },
  } as DelegationHost;
  const delegation = new Delegation(host);
  const relay = await (delegation as any).relay(child) as { abort(): void; drained: Promise<void> };
  send({ id: 1, data: { type: 'event', requestId: 'another-run', event: { type: 'ignored' } } });
  send({ id: 2, data: { type: 'event', requestId: child.requestId, event: { type: 'message_start' } } });
  send({ id: 3, data: { type: 'event', requestId: child.requestId, event: { type: 'message_end' } } });
  send({ id: 4, data: { type: 'response', id: child.requestId } });
  await relay.drained;
  assert.deepEqual(forwarded.map(frame => frame.event.event.type), ['message_start', 'message_end']);
  assert.ok(forwarded.every(frame => frame.requestId === child.parentRequestId && frame.event.agentId === child.id));
  assert.equal(closed, false, 'the parent decides when to close a drained relay');
  relay.abort();
  await Promise.all(waiting);
  assert.equal(closed, true);
});
