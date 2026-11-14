import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.ts';
import { AgentRuntime } from '../../../clients/typescript.ts';
import { OPERATOR, toolCall } from '../../../tests/runtime-server.ts';
import { toolResults } from '../../../tests/contract/http.ts';
import { compatibilityRuntime } from './compat-runtime.ts';
test(`repo API routes over the real Worker`, { timeout: 180000 }, async (t) => {
  const f = await startFixture({ entrypoint: fileURLToPath(new URL('./camelfs-worker.ts', import.meta.url)), vars: { FILE_SIGNING_SECRET: 'repo-fixture-signing-secret-at-least-32-characters' } });
  t.after(() => f.stop());
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(f.url + path, { method, headers: { authorization: `Bearer ${f.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const call = async (path: string, method = 'GET', body?: unknown, status = 200, headers = {}) => { const r = await request(path, method, body, headers); const v = await r.json() as any; assert.equal(r.status, status, `${path}: ${JSON.stringify(v)}\n${r.status >= 500 ? f.worker.logs().split('\n').filter(line => /repo unexpected|http_failed|Error:|^\s+at /.test(line)).join('\n') : ''}`); assert.equal(r.headers.get('cache-control'), 'no-store'); return v; };
  const repo = await call('/v1/repos', 'POST', { key: 'integration' }, 201), root = `/v1/repos/${repo.id}`;
  assert.equal((await call('/v1/repos', 'POST', { key: 'integration' })).id, repo.id);
  assert.equal((await call('/v1/repos')).repos.length, 1);
  await call(root);
  const a = await call(root + '/files/notes/a.txt', 'PUT', 'hello', 201);
  const immediate = await request(root + '/files/notes/a.txt');
  assert.equal(await immediate.text(), 'hello');
  assert.equal(immediate.headers.get('x-version'), a.version);
  const stat = await request(root + '/files/notes/a.txt', 'HEAD');
  assert.equal(stat.status, 200);
  assert.equal(stat.headers.get('x-version'), a.version);
  const directory = await call(root + '/files?prefix=notes');
  assert.equal(directory.version, a.version);
  assert.deepEqual(directory.entries.map((entry: { path: string }) => entry.path), ['notes/a.txt']);
  assert.match(a.blob, /^[a-f0-9]{40}$/);
  const concurrent = await Promise.all(['one', 'two'].map(body => request(root + `/files/notes/a.txt?expect=${a.blob}`, 'PUT', body)));
  assert.deepEqual(concurrent.map(r => r.status).sort(), [201, 412]);
  const win = await call(root + '/files?content=true');
  assert.equal(win.entries.length, 1);
  const v = win.version;
  const read = await request(root + '/files/notes/a.txt');
  assert.equal(await read.text(), win.entries[0].text);
  assert.equal(read.headers.get('x-version'), v);
  assert.equal((await request(root + '/files/notes/a.txt', 'HEAD')).status, 200);
  const range = await request(root + '/files/notes/a.txt', 'GET', undefined, { range: 'bytes=0-0' });
  assert.equal(range.status, 206);
  assert.equal((await range.text()).length, 1);
  await call(root + '/refs');
  await call(root + '/branches', 'POST', { name: 'topic' }, 201);
  const c = await call(root + '/commit', 'POST', { ref: 'topic', files: { 'b.txt': { text: 'topic' }, 'binary': { data: '/w==' } } });
  await call(root + '/refs/copy', 'PUT', { version: c.version });
  await call(root + '/refs/copy', 'DELETE');
  const batch = await call(root + '/files:batch', 'POST', { ref: 'topic', paths: ['notes/a.txt', 'b.txt', 'binary', 'missing'] });
  assert.deepEqual(batch.missing, ['missing']);
  assert.equal(batch.files[2].base64, '/w==');
  const blob = await request(root + `/blobs/${a.blob}?version=${a.version}&path=notes/a.txt`);
  assert.equal(await blob.text(), 'hello');
  assert.equal(blob.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  await call(root + `/blobs/${a.blob}?version=${a.version}&path=b.txt`, 'GET', undefined, 404);
  const diff = await call(root + `/diff?from=main&to=topic`);
  assert.equal(diff.changes.length, 2);
  assert.equal((await call(root + '/history', 'GET', undefined, 400)).code, 'bad_ref');
  const history = await call(root + '/history?ref=topic&limit=1');
  assert.equal(history.versions[0].version, c.version);
  assert.equal(history.versions[0].trailers['Camel-Op'], 'api');
  assert.equal(history.next, c.version);
  const next = await call(root + `/history?ref=topic&limit=1&after=${history.next}`);
  assert.equal(next.versions[0].version, v);
  const pathHistory = await call(root + '/history?ref=topic&path=notes/a.txt&limit=1');
  assert.equal(pathHistory.versions[0].version, v);
  const pathNext = await call(root + `/history?ref=topic&path=notes/a.txt&after=${pathHistory.next}`);
  assert.deepEqual(pathNext.versions.map((entry: { version: string }) => entry.version), [a.version]);
  assert.equal(pathNext.next, null);
  assert.equal((await call(root + `/history?ref=main&after=${c.version}`, 'GET', undefined, 400)).code, 'bad_cursor');
  await call(root + `/commits/${c.version}`);
  await call(root + '/log?ref=topic', 'GET', undefined, 404);
  const merged = await call(root + '/merge', 'POST', { into: 'main', from: 'topic' });
  assert.equal(merged.version, c.version);
  const grep = await call(root + '/grep?q=topic');
  assert.equal(grep.matches.length, 1);
  const archive = await request(root + '/export');
  assert.equal(archive.status, 200);
  const tar = Buffer.from(await archive.arrayBuffer());
  assert.equal(tar.subarray(257, 262).toString(), 'ustar');
  assert.ok(tar.includes(Buffer.from('topic')));
  await call(root + '/files/page.html', 'PUT', '<script>test</script>', 201);
  const html = await request(root + '/files/page.html');
  assert.match(html.headers.get('content-disposition')!, /^attachment/);
  assert.match(html.headers.get('content-security-policy')!, /sandbox/);
  const getLink = await call(root + '/links', 'POST', { path: 'b.txt' });
  assert.equal(await (await fetch(getLink.url)).text(), 'topic');
  const putLink = await call(root + '/links', 'POST', { path: 'linked.txt', method: 'PUT', maxBytes: 4, contentType: 'text/plain' });
  const put = await fetch(putLink.url, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'link' });
  assert.equal(put.status, 201);
  assert.equal(await (await request(root + '/files/linked.txt')).text(), 'link');
  assert.equal((await fetch(putLink.url, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'large' })).status, 413);
  // Signature domain separation works even when a caller changes the URL prefix.
  assert.equal((await fetch(getLink.url.replace('/repo-links/', '/files/'))).status, 403);
  await call(root + '/restore', 'POST', { version: a.version });
  assert.equal(await (await request(root + '/files/notes/a.txt')).text(), 'hello');
  await call(root + '/files/notes/a.txt', 'DELETE');
  const fork = await call('/v1/repos', 'POST', { from: { repo: repo.id, version: c.version } }, 201);
  assert.equal(fork.lineage, repo.lineage);
  const idemHeaders = { 'Idempotency-Key': 'repo-create-replay' };
  const replay = await call('/v1/repos', 'POST', { name: 'replay' }, 201, idemHeaders);
  assert.equal((await call('/v1/repos', 'POST', { name: 'replay' }, 201, idemHeaders)).id, replay.id);
  await call(root, 'DELETE');
  await call(root, 'GET', undefined, 404);
  await call('/v1/repos', 'POST', { key: 'integration' }, 409);
});
test('unconfigured repo storage returns 503', { timeout: 120000 }, async (t) => {
  const f = await startFixture({ noCamelfsTier: true });
  t.after(() => f.stop());
  for (const method of ['GET', 'POST']) {
    const r = await fetch(f.url + '/v1/repos', { method, headers: { authorization: `Bearer ${f.token}` } });
    assert.equal(r.status, 503);
    const body = await r.json() as { code: string; error: string };
    assert.equal(body.code, 'storage_unavailable');
    assert.match(body.error, /CAMELFS_URL/);
  }
});

test(`repo-backed agent tools see a write within the same turn`, { timeout: 90_000 }, async t => {
  const path = '/shared/notes/a.txt', content = 'agent read-your-write';
  const runtime = await compatibilityRuntime(t, (body: unknown, index: number) => {
    if (index === 0) return toolCall('write', { path, content });
    if (index === 1) return toolCall('ls', { path: '/shared/notes' });
    if (index === 2) return toolCall('read', { path });
    const results = toolResults(body);
    assert.match(results.at(-2), /"name":"a\.txt"/);
    assert.equal(results.at(-1), content);
    return { role: 'assistant', content: 'Read my write' };
  }, {}, undefined);
  const sdk = new AgentRuntime({ url: runtime.base, apiKey: OPERATOR });
  const created = await runtime.call('/v1/repos', { body: {} });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const repo = created.json;
  const agent = await sdk.upsertAgent('repo-read-your-write', { tools: {}, mounts: [{ repo: repo.id, path: '/shared', mode: 'rw' }] });
  const run = await runtime.prompt(agent.session.id, 'Write the file, list its directory, and read it back');
  assert.equal(run.outcome.result.reply, 'Read my write');
});

test(`agent workspace reads reuse the derived tree`, { timeout: 90_000 }, async t => {
  const path = '/workspace/notes/a.txt', content = 'agent cached read-your-write';
  let afterWrite = 0;
  const runtime = await compatibilityRuntime(t, (body: unknown, index: number) => {
    if (index === 0) return toolCall('ls', { path: '/workspace' }, 'warm');
    if (index === 1) return toolCall('write', { path, content });
    if (index === 2) {
      afterWrite = runtime.camelfsCalls!.length;
      return toolCall('ls', { path: '/workspace/notes' }, 'first-ls');
    }
    if (index === 3) return toolCall('read', { path }, 'first-read');
    if (index === 4) return toolCall('ls', { path: '/workspace/notes' }, 'second-ls');
    if (index === 5) return toolCall('read', { path }, 'second-read');
    return { role: 'assistant', content: JSON.stringify(toolResults(body).slice(-4)) };
  }, {}, undefined);
  const sdk = new AgentRuntime({ url: runtime.base, apiKey: OPERATOR });
  const agent = await sdk.upsertAgent('repo-cache-read-your-write', { tools: {} });
  const run = await runtime.prompt(agent.session.id, 'List the workspace, write the file, then list and read it twice');
  const [firstList, firstRead, secondList, secondRead] = JSON.parse(run.outcome.result.reply);
  assert.match(firstList, /"name":"a\.txt"/);
  assert.equal(firstRead, content);
  assert.equal(secondList, firstList);
  assert.equal(secondRead, content);
  assert.ok(afterWrite > 0);
  assert.deepEqual(runtime.camelfsCalls!.slice(afterWrite).filter(call => /^GET .*\/trees\//.test(call)), []);
});

test('pilot reset: dry run lists, confirm deletes agents and repos, a rerun is a no-op, other origins refuse', { timeout: 180000 }, async (t) => {
  const tenant = 'camelrun-proto-local';
  const f = await startFixture({ entrypoint: fileURLToPath(new URL('./camelfs-worker.ts', import.meta.url)),
    vars: { ADMIN_TENANTS: tenant, AGENT_PUBLIC_URL: 'https://run-pilot.camelai.dev' } });
  t.after(() => f.stop());
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(f.url + path, { method, headers: { authorization: `Bearer ${f.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() as any };
  };
  const agent = await call('/v1/agents', 'POST', { model: 'test/echo' });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  const repo = await call('/v1/repos', 'POST', { name: 'standalone' });
  assert.equal(repo.status, 201, JSON.stringify(repo.body));
  const dry = await call('/v1/internal/camelfs/pilot-reset', 'POST');
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.dryRun, true);
  assert.ok(dry.body.wouldDelete.agents.some((a: { id: string }) => a.id === agent.body.id));
  assert.ok(dry.body.wouldDelete.repos.some((r: { id: string }) => r.id === repo.body.id));
  assert.match(dry.body.untouched, /balances/);
  assert.equal((await call(`/v1/agents/${agent.body.id}`)).status, 200, 'a dry run changes nothing');
  const done = await call('/v1/internal/camelfs/pilot-reset?confirm=1', 'POST');
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.done, true); assert.deepEqual(done.body.remaining, { agents: 0, repos: 0 }); assert.deepEqual(done.body.failed, []);
  assert.equal((await call('/v1/repos')).body.repos.length, 0);
  const again = await call('/v1/internal/camelfs/pilot-reset?confirm=1', 'POST');
  assert.equal(again.status, 200); assert.deepEqual(again.body.deleted, { agents: 0, repos: 0 });
  assert.ok(f.worker.logs().includes('"type":"pilot_reset"'));

  const nonPilot = await startFixture({ vars: { ADMIN_TENANTS: tenant } });
  t.after(() => nonPilot.stop());
  const refused = await fetch(nonPilot.url + '/v1/internal/camelfs/pilot-reset?confirm=1', {
    method: 'POST', headers: { authorization: `Bearer ${nonPilot.token}` },
  });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: 'The pilot reset runs only on the pilot', code: 'FORBIDDEN' });
});
