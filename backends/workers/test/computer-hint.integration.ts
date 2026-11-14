import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.ts';

const textOf = (body: any) => body.messages.map((message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((part: any) => part.text ?? '').join('\n')).join('\n');
const toolCall = (name: string, args: unknown, id: string) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const free = { prompt_tokens: 1, completion_tokens: 1, cost: 0 };
async function within<T>(description: string, timeout: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Timed out after ${timeout} ms: ${description}`);
          reject(error);
          controller.abort(error);
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a delegated child clears its negative attachment hint before waking with the inherited connection', { timeout: 120_000 }, async t => {
  const childReachedModel = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  const provider = createServer((request, response) => {
    void within('read the model request', 5_000, async () => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      return JSON.parse(raw);
    }).then(async body => {
      let delta: object;
      if (textOf(body).includes('HINT_HELPER')) {
        childReachedModel.resolve();
        await within('release the child model response after checking its wake', 25_000, () => releaseChild.promise);
        delta = { role: 'assistant', content: 'child done' };
      } else if (body.messages.at(-1).role === 'tool') {
        delta = { role: 'assistant', content: 'parent done' };
      } else {
        delta = toolCall('delegate', { instructions: 'HINT_HELPER', task: 'Do the work', computer: 'fresh' }, 'delegate-hint');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: free })}\n\ndata: [DONE]\n\n`);
    }).catch(error => {
      t.diagnostic(String(error));
      response.writeHead(500).end();
    });
  });
  t.after(() => {
    releaseChild.resolve();
    return within('close the model server', 5_000, () => new Promise<void>(resolve => {
      provider.close(() => resolve());
      provider.closeAllConnections();
    }));
  });
  await within('start the model server', 5_000, () => new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', () => {
      provider.off('error', reject);
      resolve();
    });
  }));
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const fixture = await within('start the Worker and reach /healthz', 45_000, signal => startFixture({
    entrypoint: fileURLToPath(new URL('./computer-hint-entry.ts', import.meta.url)),
    modelURL: `http://127.0.0.1:${address.port}/v1`,
    vars: { PILOT_DB_PROFILE: '1', TEST_HOOKS: '1' },
    signal,
  }));
  t.after(() => within('stop the Worker fixture', 20_000, () => fixture.stop()));
  const call = (path: string, body?: unknown) => within(`${body === undefined ? 'GET' : 'POST'} ${path}`, 10_000, async signal => {
    const response = await fetch(fixture.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    assert.ok(response.ok, `${path}: HTTP ${response.status}`);
    return await response.json();
  });
  const { id: parent } = await call('/v1/agents', { codeMode: false, fileTools: false, builtins: ['delegate'], delegate: { instructions: true } });
  const connection = await call('/v1/computers', { agent: parent, provider: 'e2b', credentials: { apiKey: 'fixture-only' } });
  await call(`/v1/agents/${parent}/prompt`, { text: 'start' });
  await within('delegated child reaches the model after its first wake', 15_000, () => childReachedModel.promise);
  const { rows } = await within('read the inherited computer connection', 5_000, () =>
    fixture.db.query("select agent,id from computer_connections where agent<>$1", [parent]));
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, connection.id);
  const state = await call(`/experimental/agents/${rows[0].agent}/__test/computer-hint`);
  assert.equal(state.afterConfiguration, false, 'child configuration recorded a negative attachment hint');
  assert.ok(state.afterInheritance, 'child admission recorded the wake profile');
  assert.equal(state.afterInheritance.hint, null, 'inheritance cleared the negative attachment hint before wake');
  const queries = state.afterInheritance.profile.phases.other?.statements ?? {};
  assert.ok(queries['select:agents+computer_connections']?.queries > 0, 'wake swept the inherited connection');
  assert.ok(queries['select:computer_connections+computer_leases']?.queries > 0, 'wake checked the next lease deadline');
  releaseChild.resolve();
});
