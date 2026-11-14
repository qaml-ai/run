import { tierConfigured } from "../camelfs/tier.ts";
import { Buffer } from 'node:buffer';
import { tar } from '../../../../src/tar.ts';
import { sniffContentType, declaredType, downloadHeaders } from '../file-policy.ts';
import { withMoneyIdempotency } from '../money-idempotency.ts';
import { camelfsConfigured, StorageError } from './storage.ts';
import { RepoError, repoErrorFrom, check, normalizeRepoPath, page, type Entry, type Mode } from './repo-policy.ts';
import { createRepo, deleteRepo, repoContext, type RepoContext, type RepoEnv } from './registry.ts';
import { versionEntries, statPaths, listFiles } from './reads.ts';
import { commitChanges, setRefToVersion, branch, reportUsage, type WriteInput } from './write.ts';
import { repoHistory } from './history.ts';
import { mergeRefs } from './merge.ts';
import { signRepoLink } from './links.ts';
export const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export function repoFailure(e: unknown): Response {
  const r = repoErrorFrom(e);
  if (r)
    return json({ error: r.code, code: r.code, ...r.detail }, r.status);
  if (e instanceof StorageError)
    return json({ error: `storage ${e.op ?? 'call'}: ${e.reason}`, code: e.code, storage: e.op ?? null, ...(e.details ? { detail: e.details } : {}) }, e.status >= 400 ? e.status : e.status === 0 ? 503 : 502);
  if (e instanceof SyntaxError || e instanceof URIError)
    return json({ error: 'bad_input', code: 'bad_input' }, 400);
  if (e && typeof e === 'object' && 'status' in e && typeof e.status === 'number')
    return json({ error: String(e), code: 'bad_input' }, e.status);
  throw e;
}
export async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader)
    return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done)
        break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new RepoError('too_large', 413, 'too_large');
      }
      chunks.push(value);
    }
  }
  finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}
// Escaped JSON may be much larger than its decoded inline bytes.
const readJson = async (request: Request) => {
  const value = JSON.parse(new TextDecoder().decode(await boundedBody(request, 128 * 2 ** 20)));
  check(value && typeof value === 'object' && !Array.isArray(value));
  return value;
};
export const apiWrite = (tenant: string) => ({ author: `api:${tenant}`, who: `api:${tenant}`, why: 'api', trailers: { 'Camel-User': `api:${tenant}`, 'Camel-Checkpoint': 'api' } });
export async function resolved(ctx: RepoContext, params: URLSearchParams) { return ctx.repo.resolve(params.get('version') ?? params.get('ref') ?? 'main'); }
export async function fileEntry(ctx: RepoContext, v: { tree: string }, path: string): Promise<Entry> {
  const entry = (await statPaths(ctx, v.tree, [path]))[path];
  if (entry) return entry;
  throw new RepoError('no_file', 404, 'no_file');
}
export async function streamFile(request: Request, ctx: RepoContext, v: {
  version: string;
  tree: string;
}, e: Entry, immutable = false) {
  const range = request.headers.get('range');
  check(!range || /^bytes=(?:\d+-\d*|-\d+)$/.test(range), 'bad_range');
  const response = await ctx.storage.openBlob(ctx.lineage, e.blob, v.tree, e.path, range ?? undefined), headers = new Headers(response.headers);
  headers.set('x-blob', e.blob);
  headers.set('x-version', v.version);
  headers.set('x-mode', e.mode);
  headers.set('etag', `"${e.blob}"`);
  headers.set('cache-control', immutable ? 'private, max-age=31536000, immutable' : 'no-store');
  // Read just a prefix for sniffing, then put that chunk back into the stream.
  const reader = response.body?.getReader();
  const first = reader ? await reader.read() : { done: true, value: undefined };
  headers.set('content-type', declaredType(headers.get('content-type')) ?? sniffContentType(first.value ?? new Uint8Array(), e.path));
  for (const [key, value] of Object.entries(downloadHeaders(headers.get('content-type')!, e.path)))
    headers.set(key, value);
  if (request.method === 'HEAD') {
    await reader?.cancel();
    return new Response(null, { status: response.status, headers });
  }
  const body = new ReadableStream<Uint8Array>({ start(c) {
      if (first.value)
        c.enqueue(first.value);
      if (first.done)
        c.close();
    }, async pull(c) {
      if (!reader)
        return;
      try {
        const next = await reader.read();
        if (next.done)
          c.close();
        else
          c.enqueue(next.value);
      }
      catch (e) {
        c.error(e);
      }
    }, cancel(reason) { return reader?.cancel(reason); } });
  return new Response(body, { status: response.status, headers });
}
async function contents(ctx: RepoContext, tree: string, entries: Entry[], limit = 16 * 2 ** 20) {
  if (entries.length > 1000 || entries.reduce((s, e) => s + e.size, 0) > limit)
    throw new RepoError('too_large', 413, 'too_large');
  const result: unknown[] = [];
  let used = 0;
  for (let i = 0; i < entries.length; i += 256) {
    const batch = await ctx.storage.readBatch(ctx.lineage, tree, entries.slice(i, i + 256).map(e => e.path), limit - used);
    for (const e of batch) {
      if ('error' in e)
        throw new RepoError('no_file', 404, 'no_file');
      used += e.bytes.length;
      if (used > limit)
        throw new RepoError('too_large', 413, 'too_large');
      const { bytes, ...rest } = e;
      let content;
      try {
        content = { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) };
      }
      catch {
        content = { base64: Buffer.from(bytes).toString('base64') };
      }
      result.push({ ...rest, ...content });
    }
  }
  return result;
}
export async function handleRepoRequest(request: Request, env: RepoEnv, principal: {
  tenantId: string;
}, path = new URL(request.url).pathname): Promise<Response | null> {
  if (path !== '/v1/repos' && !path.startsWith('/v1/repos/'))
    return null;
  if (!camelfsConfigured(env))
    return json({ code: 'storage_unavailable' }, 503);
  try {
    if (request.method === 'POST' && request.headers.has('Idempotency-Key'))
      return await withMoneyIdempotency(request, env, principal.tenantId, r => route(r, env, principal.tenantId, path)) ?? null;
    return await route(request, env, principal.tenantId, path);
  }
  catch (e) {
    return repoFailure(e);
  }
}
async function route(request: Request, env: RepoEnv, tenant: string, path: string): Promise<Response> {
  const url = new URL(request.url), s = url.searchParams, method = request.method;
  const number = (k: string) => s.has(k) ? Number(s.get(k)) : undefined;
  if (path === '/v1/repos') {
    if (method === 'POST') {
      const r = await createRepo(env, tenant, { ...await readJson(request), ...(tierConfigured(env) ? { author: `api:${tenant}` } : {}) });
      return json(r.info, r.existing ? 200 : 201);
    }
    if (method === 'GET') {
      const p = await env.TENANTS.getByName(tenant).listRepos({ after: s.get('after') ?? undefined, limit: number('limit') });
      return json({ ...p, repos: p.repos.map(({ id, name, key, createdAt, lineage, bytes, files }) => ({
        id, name, key, createdAt,
        ...(tierConfigured(env) && lineage !== `${tenant}:${id}` ? { sharesStorageWith: lineage.slice(tenant.length + 1) } : { bytes, files }),
      })) });
    }
  }
  const match = /^\/v1\/repos\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!match)
    throw new RepoError('not_found', 404, 'not_found');
  const id = decodeURIComponent(match[1]), tail = match[2] ?? '';
  if (!tail && method === 'DELETE') return json(await deleteRepo(env, tenant, id));
  const ctx = await repoContext(env, tenant, id), ref = s.get('ref') ?? 'main', actor = apiWrite(tenant);
  if (!tail && method === 'GET')
    return json(await ctx.repo.info());
  if (tail === 'refs' && method === 'GET')
    return json(await ctx.repo.refs());
  if (tail.startsWith('refs/')) {
    const name = decodeURIComponent(tail.slice(5));
    if (method === 'PUT') {
      const b = await readJson(request);
      return json(await setRefToVersion(ctx, { ...b, ref: name, newCommit: false, ...actor }));
    }
    if (method === 'DELETE') {
      for (let attempt = 0;; attempt++) {
        const head = await ctx.repo.ref(name);
        if (!head)
          throw new RepoError('no_ref', 404, 'no_ref');
        try {
          await ctx.repo.deleteRef(name, s.get('expect') ?? head.version);
          break;
        }
        catch (error) {
          if (repoErrorFrom(error)?.code !== 'stale' || s.has('expect') || attempt >= 3)
            throw error;
        }
      }
      await reportUsage(ctx);
      return json({ deleted: true });
    }
  }
  if (tail === 'branches' && method === 'POST') {
    const b = await readJson(request);
    return json(await branch(ctx, { name: b.name, from: b.from ?? 'main', owner: b.owner, ttlSeconds: b.ttl, who: actor.who }), 201);
  }
  if (tail === 'history' && method === 'GET')
    return json(await repoHistory(ctx, { ref: s.get('ref') ?? '', after: s.get('after') ?? undefined, limit: number('limit'), path: s.get('path') ?? undefined }));
  if (tail.startsWith('commits/') && method === 'GET') {
    const v = await ctx.repo.commit(decodeURIComponent(tail.slice(8)));
    if (!v)
      throw new RepoError('no_commit', 404, 'no_commit');
    return json(v);
  }
  if (tail === 'diff' && method === 'GET') {
    const from = await ctx.repo.resolve(s.get('from') ?? 'main'), to = await ctx.repo.resolve(s.get('to') ?? 'main');
    const prefix = s.get('path');
    return json(await ctx.storage.diff(ctx.lineage, from.tree, to.tree, prefix ? normalizeRepoPath(prefix.replace(/\/$/, '')) : undefined));
  }
  if (tail === 'restore' && method === 'POST') {
    const b = await readJson(request);
    return json(await setRefToVersion(ctx, { ref: b.ref ?? 'main', version: b.version, message: b.message, newCommit: true, ...actor }));
  }
  if (tail === 'merge' && method === 'POST')
    return json(await mergeRefs(ctx, await readJson(request)));
  if (tail === 'links' && method === 'POST')
    return json(await signRepoLink(ctx, url.origin, await readJson(request)));
  if (tail === 'commit' && method === 'POST') {
    const b = await readJson(request);
    check(b.files && typeof b.files === 'object' && !Array.isArray(b.files));
    const changes: WriteInput['changes'] = Object.create(null);
    let size = 0;
    check(Object.keys(b.files).length <= 1000);
    for (const [p, raw] of Object.entries(b.files)) {
      const c = raw as any;
      if (c === null) {
        changes[p] = null;
        continue;
      }
      check(c && typeof c === 'object');
      if ('text' in c || 'data' in c) {
        check(typeof (c.text ?? c.data) === 'string');
        const bytes = 'text' in c ? new TextEncoder().encode(c.text) : new Uint8Array(Buffer.from(c.data, 'base64'));
        size += bytes.length;
        changes[p] = { bytes, mode: c.mode };
      }
      else {
        check('blob' in c || 'from' in c || 'mode' in c);
        changes[p] = c;
      }
    }
    if (size > 16 * 2 ** 20)
      throw new RepoError('too_large', 413, 'too_large');
    return json(await commitChanges(ctx, { ref: b.ref ?? 'main', expect: b.expect, changes, message: b.message ?? 'commit', op: 'api', ...actor }));
  }
  if (tail.startsWith('files/') && (method === 'PUT' || method === 'DELETE')) {
    const p = normalizeRepoPath(decodeURIComponent(tail.slice(6))), expect = s.get('expect');
    if (method === 'DELETE') {
      const head = await ctx.repo.ref(ref);
      if (!head || (await statPaths(ctx, head.tree, [p]))[p] === null)
        throw new RepoError('no_file', 404, 'no_file');
    }
    const result = await commitChanges(ctx, { ref, op: 'api', changes: { [p]: method === 'DELETE' ? null : { bytes: await boundedBody(request, 256 * 2 ** 20), mode: (request.headers.get('x-mode') ?? undefined) as Mode | undefined } }, pathExpect: expect ? { [p]: expect } : undefined, message: `${method === 'PUT' ? 'put' : 'delete'} ${p.slice(0, 1000)}`, ...actor });
    if (method === 'DELETE') return json({ version: result.version, deleted: true });
    const e = result.files[p] ?? await fileEntry(ctx, { tree: result.tree! }, p);
    return json({ version: result.version, blob: e.blob, path: p, size: e.size }, 201);
  }
  if (tail === 'files:batch' && method === 'POST') {
    const b = await readJson(request);
    check(Array.isArray(b.paths) && b.paths.length <= 1000);
    const params = new URLSearchParams();
    if (b.ref)
      params.set('ref', b.ref);
    if (b.version)
      params.set('version', b.version);
    const target = await resolved(ctx, params), paths = b.paths.map(normalizeRepoPath) as string[];
    const all = await statPaths(ctx, target.tree, paths);
    const entries = paths.flatMap(p => all[p] ? [all[p]] : []);
    return json({ version: target.version, files: await contents(ctx, target.tree, entries), missing: paths.filter(p => !all[p]) });
  }
  if ((tail.startsWith('files/') || tail.startsWith('blobs/')) && (method === 'GET' || method === 'HEAD')) {
    const v = await resolved(ctx, s);
    const blob = tail.startsWith('blobs/'), p = normalizeRepoPath(blob ? s.get('path') ?? '' : decodeURIComponent(tail.slice(6))), e = await fileEntry(ctx, v, p);
    if (blob && e.blob !== decodeURIComponent(tail.slice(6)))
      throw new RepoError('not_in_tree', 404, 'not_in_tree');
    return streamFile(request, ctx, v, e, blob);
  }
  if (tail === 'files' && method === 'GET') {
    const v = await resolved(ctx, s);
    const prefix = s.get('prefix') ? normalizeRepoPath(s.get('prefix')!.replace(/\/$/, '')) : undefined, after = s.get('after') ?? '', limit = page(number('limit'), 1000, 10000);
    const { entries, next } = await listFiles(ctx, v.tree, { path: prefix, after: after || undefined, limit });
    return json({ version: v.version, entries: s.get('content') === 'true' ? await contents(ctx, v.tree, entries) : entries, next });
  }
  if (tail === 'grep' && method === 'GET') {
    const v = await resolved(ctx, s);
    return json(await ctx.storage.grep(ctx.lineage, { tree: v.tree, q: s.get('q') ?? '', regex: s.get('regex') === 'true' || s.get('regex') === '1', ignoreCase: s.get('ignoreCase') === 'true' || s.get('ignoreCase') === '1', path: s.get('path') ?? undefined, limit: number('limit') }));
  }
  if (tail === 'export' && method === 'GET') {
    const v = await resolved(ctx, s);
    const entries = await versionEntries(ctx, v.tree);
    if (entries.length > 10000 || entries.reduce((s, e) => s + e.size, 0) > 2 ** 30)
      throw new RepoError('too_large', 413, 'too_large');
    async function* files() {
      for (let i = 0; i < entries.length;) {
        const paths: string[] = [];
        let size = 0;
        while (i < entries.length && paths.length < 256 && size + entries[i].size <= 64 * 2 ** 20) {
          paths.push(entries[i].path);
          size += entries[i++].size;
        }
        if (!paths.length) {
          const e = entries[i++];
          yield { name: e.path, size: e.size, mtime: 0, async *stream() {
              const r = await ctx.storage.openBlob(ctx.lineage, e.blob, v.tree, e.path);
              const reader = r.body!.getReader();
              try {
                for (;;) {
                  const part = await reader.read();
                  if (part.done)
                    break;
                  yield part.value;
                }
              }
              finally {
                await reader.cancel();
                reader.releaseLock();
              }
            } };
          continue;
        }
        const batch = await ctx.storage.readBatch(ctx.lineage, v.tree, paths);
        for (const e of batch) {
          if ('error' in e)
            throw new RepoError('no_file', 404, 'no_file');
          yield { name: e.path, size: e.size, mtime: 0, async *stream() { yield e.bytes; } };
        }
      }
    }
    const archive = tar(files()), body = new ReadableStream<Uint8Array>({ async pull(c) {
        try {
          const n = await archive.next();
          if (n.done)
            c.close();
          else
            c.enqueue(n.value);
        }
        catch (e) {
          c.error(e);
        }
      }, async cancel() { await archive.return(undefined); } });
    return new Response(body, { headers: { 'content-type': 'application/x-tar', 'cache-control': 'no-store' } });
  }
  throw new RepoError('not_found', 404, 'not_found');
}
