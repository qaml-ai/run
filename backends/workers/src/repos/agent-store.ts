import { FileError } from '../volume.ts';
import { sniffContentType } from '../file-policy.ts';
import { repoContext, type RepoEnv } from './registry.ts';
import { commitChanges, type WriteInput } from './write.ts';
import { repoErrorFrom, type Entry } from './repo-policy.ts';
export const insideRepo = (path: string) => path.replace(/^\/+/, '');
export async function agentStore(env: RepoEnv, tenant: string, repo: string, ref = 'main', agent = '', identity: Record<string,string> = {}) {
  const ctx = await repoContext(env, tenant, repo);
  const decorate = (entry: {path: string; blob: string; size: number}, version: string) => ({ ...entry, path: '/' + entry.path, version, contentType: sniffContentType(new Uint8Array(), entry.path) });
  // The head entry from the object's cache (one RPC); `sniff` reads the first 512 bytes for the content type.
  // With `version` (e.g. the commit an attachment landed in), a version the ref has moved past lists its directory.
  const entryAt = async (path: string, version?: string) => {
    const p = insideRepo(path);
    if (!p) throw new FileError(`File not found: ${path}`, 404);
    let head: { version: string; tree: string; entries: Record<string, Entry | null> };
    try { head = await ctx.stub.stat(ref, [p]); }
    catch (e) { if (repoErrorFrom(e)?.code === 'no-ref') throw new FileError(`File not found: ${path}`, 404); throw e; }
    if (version !== undefined && head.version !== version) {
      const v = await ctx.stub.resolve(version), dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : undefined;
      const found = (await ctx.storage.listAll(ctx.lineage, v.tree, dir)).find((e): e is Entry => 'blob' in e && e.path === p);
      head = { version: v.version, tree: v.tree, entries: { [p]: found ?? null } };
    }
    const entry = head.entries[p];
    if (!entry) throw new FileError(`File not found: ${path}`, 404);
    return { p, entry, head };
  };
  const stat = async (path: string, version?: string) => {
    const { p, entry, head } = await entryAt(path, version);
    const bytes = entry.size ? await ctx.storage.readBlob(ctx.lineage, entry.blob, head.tree, p, `bytes=0-${Math.min(512, entry.size) - 1}`) : new Uint8Array();
    return { ...decorate(entry, head.version), contentType: sniffContentType(bytes, p) };
  };
  const commit = async (changes: WriteInput['changes'], pathExpect: WriteInput['pathExpect'] = {}, message = 'files changed', trailers: Record<string,string> = {}) => {
    try { return await commitChanges(ctx, { ref, changes, pathExpect, message, author: `agent:${agent}`, who: `agent:${agent}`, why: 'agent', trailers: { 'Camel-Agent': agent, 'Camel-Checkpoint': 'automatic', ...identity, ...trailers } }); }
    catch (error) { if (repoErrorFrom(error)?.code === 'stale-path') throw new FileError('File changed since you last read it; read it again, then retry against its current content', 412); throw error; }
  };
  return { ctx, ref, stat, commit,
    async list(path = '/', _version?: string, pattern?: string) {
      // Only the subtree under `path`, paged from the object's head cache.
      const prefix = insideRepo(path), entries: Entry[] = [];
      let after: string | undefined, version: string | undefined;
      do {
        let page;
        try { page = await ctx.stub.list({ ref, prefix: prefix || undefined, after, limit: 10000 }); }
        catch (e) { if (repoErrorFrom(e)?.code === 'no-ref') return []; throw e; }
        if (version !== undefined && page.version !== version) { entries.length = 0; after = undefined; version = undefined; continue; }
        version = page.version; entries.push(...page.entries); after = page.next ?? undefined;
      } while (after);
      return entries.filter(e => !pattern || globMatch(e.path.slice(prefix ? prefix.length + 1 : 0), pattern)).map(e => decorate(e, version!));
    },
    async read(path: string, _version?: string, maxBytes = 1024 * 1024) {
      const { p, entry, head } = await entryAt(path);
      if (entry.size > maxBytes) throw new FileError('Tool file exceeds 1 MiB', 413);
      const bytes = await ctx.storage.readBlob(ctx.lineage, entry.blob, head.tree, p);
      return { file: { ...decorate(entry, head.version), contentType: sniffContentType(bytes.subarray(0, 512), p) }, bytes };
    },
    async write(path: string, bytes: Uint8Array, contentType: string, expected?: string) {
      const p = insideRepo(path); const result = await commit({[p]: { bytes }}, expected === undefined ? {} : {[p]: expected}, `write ${p}`);
      // An unchanged write moves nothing: answer with the current entry.
      const entry = result.files[p] ?? (await entryAt(path)).entry;
      return { ...decorate(entry, result.version!), version: result.version!, contentType };
    },
  };
}
export function globMatch(path: string, pattern: string): boolean {
  let re = '';
  for (let i=0;i<pattern.length;i++) {
    const c=pattern[i];
    if(c==='*') { if(pattern[i+1]==='*') { i++; if(pattern[i+1]==='/') { i++; re+='(?:.*/)?'; } else re+='.*'; } else re+='[^/]*'; }
    else if(c==='?') re+='[^/]'; else if(c==='{') re+='(?:'; else if(c==='}') re+=')'; else if(c===',') re+='|'; else re+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  }
  return new RegExp('^'+re+'$').test(path);
}
