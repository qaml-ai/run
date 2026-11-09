import { contractTest, OTHER_OPERATOR, toolCall } from '../support.ts';
import assert from 'node:assert/strict';

contractTest('history', 'tests/session-transcripts.test.ts:1', 'time-filtered conversation pages authorize the root and bind cursors to their window', async (_t, f) => {
  f.setModel(() => ({content: 'remember this'}));
  const agent = (await f.call('/v1/agents', {body: {}})).json.id;
  const from = Date.now() - 1000;
  await f.prompt(agent, 'hello');
  const path = `/v1/agents/${agent}/sessions?from=${from}&to=${Date.now() + 1000}`;
  const first = await f.call(path);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.agentId, agent);
  assert.ok(first.json.entries.length >= 2);
  const end = await f.call(`${path}&cursor=${encodeURIComponent(first.json.next)}`);
  assert.equal(end.json.next, null);
  assert.equal((await f.call(path, {token: OTHER_OPERATOR})).status, 404);
  assert.equal((await f.call(`/v1/agents/${agent}/sessions?from=2&to=1`)).status, 400);
});

contractTest('history', 'tests/session-transcripts.test.ts:1', 'session pages include delegate descendants and can restrict reads to the parent', async (_t, f) => {
  f.setModel(body => {
    const text = JSON.stringify(body.messages);
    if (text.includes('CHILD_MARKER')) return {content: 'child evidence'};
    if (body.messages.at(-1)?.role === 'tool') return {content: 'parent done'};
    return toolCall('delegate', {instructions: 'CHILD_MARKER', task: 'child task'}, 'delegate_once');
  });
  const agent = (await f.call('/v1/agents', {body: {builtins: ['delegate'], delegate: {instructions: true}}})).json.id;
  const from = Date.now() - 1000;
  await f.prompt(agent, 'start');
  const collect = async (children: boolean) => {
    let cursor: string | undefined; const pages: any[] = [];
    const to = Date.now() + 1000;
    for (let n = 0; n < 50; n++) {
      const page = await f.call(`/v1/agents/${agent}/sessions?from=${from}&to=${to}&children=${children}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(page.status, 200, page.text); pages.push(page.json);
      if (!page.json.next) return pages;
      cursor = page.json.next;
    }
    throw new Error('Session pages did not terminate');
  };
  const pages = await collect(true);
  assert.ok(pages.some(page => page.agentId && page.agentId !== agent && page.entries.length));
  assert.ok((await collect(false)).every(page => page.agentId === null || page.agentId === agent));
});
