import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { VmFiles } from '../src/camelfs/vm-files.ts';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil=p=>p;', shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { repoTools } = await import('../src/repos/tools.ts');
const { handleAgentFileRequest, handleAgentFilesRoute } = await import('../src/repos/agent-files.ts');
const { presentedFile } = await import('../src/file-output.ts');
const { handleSignedFileRequest } = await import('../src/images.ts');
hooks.deregister();

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const scope = { tenant: 't', agent: 'a', repo: 'repo_demo', ref: 'work' };
const mounts = [{ repo: scope.repo, ref: scope.ref, path: '/workspace', mode: 'rw' as const, subpath: '/nested' }];
const noRef = new Proxy({}, { get: (_, key) => assert.fail(`Unexpected ref access: ${String(key)}`) });

function memoryVm() {
  const files = new Map<string, Uint8Array>([
    ['nested/a.txt', encode('hello\nworld')],
    ['nested/dir/b.txt', encode('hello again')],
    ['nested/dir/c.json', encode('{}')],
    ['nested-other/private.txt', encode('private')],
  ]);
  const stat = (path: string) => {
    const bytes = files.get(path);
    return bytes ? { size: bytes.length, sha256: sha256(bytes), mode: '100644' } : null;
  };
  function check(path: string, expected?: string) {
    if (expected !== undefined && (stat(path)?.sha256 ?? 'none') !== expected)
      throw Object.assign(new Error('stale'), { code: 'stale_path' });
  }
  const vm: VmFiles = {
    async stat(paths) { return Object.fromEntries(paths.map(path => [path, stat(path)])); },
    async read(path, options) {
      const bytes = files.get(path)!;
      const offset = options?.offset ?? 0;
      return { ...stat(path)!, bytes: bytes.slice(offset, options?.length === undefined ? undefined : offset + options.length) };
    },
    async write(path, bytes, options) {
      check(path, options?.expectSha256);
      files.set(path, bytes);
      return stat(path)!;
    },
    async delete(paths, options) {
      for (const path of paths) check(path, options?.expectSha256?.[path]);
      for (const path of paths) files.delete(path);
    },
    async list({ prefix = '', after, recursive }) {
      assert.equal(recursive, true);
      const paths = [...files.keys()].sort().filter(path => path.startsWith(prefix) && (!after || path > after));
      // Force the tools to follow a cursor through multiple pages.
      return { entries: paths.slice(0, 2).map(path => ({ path, ...stat(path)! })), next: paths.length > 2 ? paths[1] : undefined };
    },
    async grep({ q, path, limit }) {
      assert.equal(path, 'nested/**');
      assert.equal(limit, 100);
      assert.equal(q, 'hello');
      return { files: 2, truncated: false, matches: [{ path: 'nested/a.txt', line: 1, text: 'hello' }, { path: 'nested/dir/b.txt', line: 1, text: 'hello again' }] };
    },
  };
  const provider = async (given: typeof scope) => {
    assert.deepEqual(given, scope);
    return vm;
  };
  return { files, vm, provider };
}

test('all routed repo tools use the VM and preserve version and output semantics', async () => {
  const { files, provider } = memoryVm();
  const seen = new Map<string, string>();
  const presented: unknown[] = [];
  const tools = repoTools(noRef as never, 't', 'a', async () => mounts,
    async (file, path, bytes) => { presented.push(file, path, decode(bytes!)); }, undefined,
    { get: key => seen.get(key), remember: (key, value) => { seen.set(key, value); } }, {}, provider);
  const run = async (name: string, args: any) => (await tools.find(tool => tool.name === name)!.execute(args, {} as never, {} as never)).output;
  const result = async (name: string, args: any) => JSON.parse((await run(name, args))[0].text);
  const path = '/workspace/a.txt';
  const version = sha256(files.get('nested/a.txt')!);
  assert.deepEqual((await run('read', { path, limit: 1 })).map(part => part.text), ['hello\n[Continue at line 2]', JSON.stringify({ version })]);
  const base64 = await result('read', { path, encoding: 'base64', offset: 6, length: 2 });
  assert.equal(base64.version, version);
  assert.equal(base64.nextOffset, 8);
  assert.equal(Buffer.from(base64.data, 'base64').toString(), 'wo');
  assert.deepEqual((await result('ls', {})).entries.map(entry => entry.name), ['a.txt', 'dir']);
  assert.deepEqual(await result('glob', { pattern: '**/*.txt', limit: 1 }), { paths: [path], truncated: true });
  assert.deepEqual(await result('grep', { pattern: 'hello', glob: 'dir/*.txt' }), {
    files: 2, truncated: false, matches: [{ path: '/workspace/dir/b.txt', line: 1, text: 'hello again' }],
  });
  const edit = { path, edits: [{ oldText: 'hello', newText: 'edited' }] };
  assert.equal((await result('edit', edit)).version, sha256(encode('edited\nworld')));
  assert.equal(decode(files.get('nested/a.txt')!), 'edited\nworld');
  files.set('nested/a.txt', encode('bash changed the file'));
  await assert.rejects(run('edit', edit), /changed since you last read it/);
  await assert.rejects(run('write', { path, content: 'stale' }), /changed since you last read it/);
  await run('read', { path });
  const written = await result('write', { path, content: 'updated' });
  assert.equal(written.version, sha256(encode('updated')));
  assert.equal((await result('present_file', { path })).presented, true);
  assert.equal(presented[1], '/nested/a.txt');
  assert.equal(presented[2], 'updated');
  assert.deepEqual(await result('delete', { path }), { deleted: true });
  assert.equal(files.has('nested/a.txt'), false);
  files.set('nested/a.txt', encode('recreated in bash'));
  await assert.rejects(run('write', { path, content: 'do not overwrite' }), /changed since you last read it/);

  files.set('nested/large.txt', new Uint8Array(1024 * 1024 + 1));
  await assert.rejects(run('read', { path: '/workspace/large.txt' }), /Tool file exceeds 1 MiB/);
});

test('VM edit maps atomic stale_path and a failed VM call retains its underlying code', async () => {
  const { vm, provider } = memoryVm();
  const tools = repoTools(noRef as never, 't', 'a', async () => mounts, undefined, undefined, undefined, {}, provider);
  const run = (name: string, args: any) => tools.find(tool => tool.name === name)!.execute(args, {} as never, {} as never);
  const path = '/workspace/a.txt';
  vm.write = async (_, __, options) => {
    assert.equal(options?.expectSha256, sha256(encode('hello\nworld')));
    throw Object.assign(new Error('stale'), { code: 'stale_path' });
  };
  await assert.rejects(run('edit', { path, edits: [{ oldText: 'hello', newText: 'edited' }] }), /changed since you last read it/);
  const stopped = Object.assign(new Error('session lost'), { code: 'session_lost' });
  vm.read = async () => { throw stopped; };
  await assert.rejects(run('read', { path }), {
    code: 'session_lost', message: 'the VM for work stopped during the operation; run it again',
  });
});

test('agent file HTTP operations use VM pagination, ranges and conditional writes', async () => {
  const { files, vm, provider } = memoryVm();
  const env = noRef as never;
  const item = (init?: RequestInit) => handleAgentFileRequest(new Request('https://agent.invalid/files', init),
    env, 't', 'a', '/workspace/a.txt', mounts, 'turn', provider);
  const page = async (query: string) => (await handleAgentFilesRoute(new Request('https://agent.invalid/files?' + query),
    env, 't', 'a', mounts, '/files', provider))!.json();
  const first = await page('path=/workspace&glob=**/*.txt&limit=1');
  assert.equal(first.next, '/workspace/a.txt');
  const second = await page('path=/workspace&glob=**/*.txt&limit=1&after=' + first.next);
  assert.deepEqual(second.files.map(file => file.path), ['/workspace/dir/b.txt']);
  assert.equal(second.next, undefined);
  const range = await item({ headers: { range: 'bytes=-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 6-10/11');
  assert.equal(await range.text(), 'world');
  const etag = range.headers.get('etag')!;
  const put = await item({ method: 'PUT', body: 'new', headers: { 'if-match': etag } });
  assert.equal(put.status, 201);
  assert.equal((await put.json()).version, sha256(encode('new')));
  assert.equal((await item({ method: 'PUT', body: 'refuse', headers: { 'if-none-match': '*' } })).status, 412);
  assert.equal((await item({ method: 'DELETE', headers: { 'if-match': etag } })).status, 412);
  assert.equal((await item({ method: 'DELETE' })).status, 200);
  assert.equal(files.has('nested/a.txt'), false);
  assert.equal((await item()).status, 404);
  vm.stat = async () => { throw Object.assign(new Error('lost'), { code: 'session_lost' }); };
  assert.deepEqual(await (await item()).json(), {
    code: 'session_lost', error: 'the VM for work stopped during the operation; run it again',
  });
});

test('presentation downloads the bytes captured from the VM without a ref lookup', async () => {
  const { provider } = memoryVm();
  const objects = new Map();
  const env = {
    FILE_SIGNING_SECRET: 'test-only-signing-secret-for-presentations',
    BUCKET: {
      async put(key, body, options) { objects.set(key, { body, httpMetadata: options.httpMetadata }); },
      async get(key) { return objects.get(key); },
    },
  };
  const data = new Map();
  const storage = { transaction: fn => fn({ get: key => data.get(key), put: (key, value) => data.set(key, value) }) };
  const events: any[] = [];
  const tools = repoTools(noRef as never, 't', 'a', async () => mounts, (file, path, bytes) =>
    presentedFile(storage as never, env as never, { tenant: 't', requestId: 'r', callId: 'c', origin: 'https://agent.invalid' },
      file, path, async event => { events.push(event); }, bytes), undefined, undefined, {}, provider);
  await tools.find(tool => tool.name === 'present_file')!.execute({ path: '/workspace/a.txt' }, {} as never, {} as never);
  const response = await handleSignedFileRequest(new Request(events[0].event.url), env as never);
  assert.equal(await response!.text(), 'hello\nworld');
  assert.match(response!.headers.get('content-disposition')!, /a\.txt$/);
});
