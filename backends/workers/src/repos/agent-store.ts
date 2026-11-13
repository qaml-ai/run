import { FileError } from '../volume.ts';
import { sniffContentType } from '../file-policy.ts';
import { repoContext, versionEntries, type RepoEnv } from './registry.ts';
import { commitChanges, type WriteInput } from './write.ts';
import { repoErrorFrom } from './repo-policy.ts';
export const insideRepo = (path: string) => path.replace(/^\/+/, '');
export async function agentStore(env: RepoEnv, tenant: string, repo: string, ref = 'main', agent = '', identity: Record<string,string> = {}) {
  const ctx = await repoContext(env, tenant, repo);
  const decorate = (entry: {path: string; blob: string; size: number}, version: string) => ({ ...entry, path: '/' + entry.path, version, contentType: sniffContentType(new Uint8Array(), entry.path) });
  const stat = async (path: string, version?:string) => {
    const p = insideRepo(path);
    if(!p)throw new FileError(`File not found: ${path}`,404);
    if (!await ctx.stub.ref(ref)) throw new FileError(`File not found: ${path}`, 404);
    const head=version?await ctx.stub.resolve(version):await ctx.stub.stat(ref,[p]);
    const entry='entries'in head?head.entries[p]:(await versionEntries(ctx,head.version,head.tree)).find(e=>e.path===p);
    if (!entry) throw new FileError(`File not found: ${path}`, 404);
    const bytes=entry.size ? await ctx.storage.readBlob(ctx.lineage,entry.blob,head.tree,p,`bytes=0-${Math.min(512,entry.size)-1}`) : new Uint8Array();
    return {...decorate(entry,head.version),contentType:sniffContentType(bytes,p)};
  };
  const commit = async (changes: WriteInput['changes'], pathExpect: WriteInput['pathExpect'] = {}, message = 'files changed', trailers: Record<string,string> = {}) => {
    try { return await commitChanges(ctx, { ref, changes, pathExpect, message, author: `agent:${agent}`, who: `agent:${agent}`, why: 'agent', trailers: { 'Camel-Agent': agent, 'Camel-Checkpoint': 'automatic', ...identity, ...trailers } }); }
    catch (error) { if (repoErrorFrom(error)?.code === 'stale-path') throw new FileError('File changed since you last read it; read it again, then retry against its current content', 412); throw error; }
  };
  return { ctx, ref, stat, commit,
    async list(path = '/', _version?: string, pattern?: string) {
      const head = await ctx.stub.ref(ref); if (!head) return [];
      const prefix = insideRepo(path);
      const entries = await versionEntries(ctx, head.version, head.tree);
      return entries.filter(e => (!prefix || e.path === prefix || e.path.startsWith(prefix + '/')) && (!pattern || globMatch(e.path.slice(prefix ? prefix.length + 1 : 0), pattern))).map(e => decorate(e, head.version));
    },
    async read(path: string, _version?: string, maxBytes = 1024 * 1024) {
      const file = await stat(path); if (file.size > maxBytes) throw new FileError('Tool file exceeds 1 MiB', 413);
      const v = await ctx.stub.resolve(file.version);
      return { file, bytes: await ctx.storage.readBlob(ctx.lineage, file.blob, v.tree, insideRepo(path)) };
    },
    async write(path: string, bytes: Uint8Array, contentType: string, expected?: string) {
      const p = insideRepo(path); const result = await commit({[p]: { bytes }}, expected === undefined ? {} : {[p]: expected}, `write ${p}`);
      return { ...await stat(path,result.version!), version: result.version!, contentType };
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
