import assert from 'node:assert/strict';
import test from 'node:test';
import { followEvents } from '../src/event-follow.ts';

test('the internal MCP watcher resumes its socket cursor and releases it on abort', async () => {
  const stop = new AbortController(), items: any[] = [], cursors: (string | null)[] = [];
  const sockets: (EventTarget & { close(): void })[] = [];
  let closes = 0;
  const send = (socket: EventTarget, frame: object) => socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) }));
  const fetcher: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('upgrade'), 'websocket');
    assert.equal(headers.get('sec-websocket-protocol'), 'camelrun.events.v1');
    assert.equal(headers.get('accept'), null);
    cursors.push(headers.get('last-event-id'));
    let closed = false;
    const socket = Object.assign(new EventTarget(), {
      accept() { queueMicrotask(() => {
        send(socket, { event: 'ready', data: {} });
        if (sockets.length === 1) {
          send(socket, { id: 7, data: { type: 'event', value: 'before reconnect' } });
          socket.close();
        }
      }); },
      close() { if (!closed) { closed = true; closes++; socket.dispatchEvent(new Event('close')); } },
    });
    sockets.push(socket);
    return { status: 101, webSocket: socket } as unknown as Response;
  };
  await followEvents({ fetch: fetcher, authorization: 'Bearer test', events: 'https://runtime.test/events?watch=1' }, { push(item) { items.push(item); } }, stop.signal);
  const until = Date.now() + 3000;
  while (cursors.length < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(cursors, [null, '7']);
  assert.ok(items.some(item => item.kind === 'event' && item.data.value === 'before reconnect'));
  assert.ok(items.some(item => item.kind === 'reconnected'));
  stop.abort();
  assert.equal(closes, 2);
});

test('the internal MCP watcher propagates permanent handshake refusals', async () => {
  const stop = new AbortController(), items: any[] = [];
  const fetcher: typeof fetch = async () => Response.json({ error: 'Too many subscribers' }, { status: 429 });
  await assert.rejects(followEvents({ fetch: fetcher, authorization: 'Bearer test', events: 'https://runtime.test/events' }, { push(item) { items.push(item); } }, stop.signal), /Too many subscribers/);
  assert.equal(items[0].kind, 'failed');
  stop.abort();
});
