import { agentStore, insideRepo } from './agent-store.ts';
import { agentRepoId, type Mount } from './mounts.ts';
import type { FileBindings } from '../files.ts';
import type { RepoEnv } from './registry.ts';
import { FileError, normalizePath } from '../file-errors.ts';
import { downloadHeaders, safeName } from '../file-policy.ts';
import { boundedBytes } from '../images.ts';
import { streamFile, repoFailure } from './routes.ts';
import { signRepoLink } from './links.ts';
import type { VmFiles } from '../camelfs/vm-files.ts';
import { check } from './repo-policy.ts';
import { heldFileError, resolveVmFiles, vmEntry, vmList, vmOperation, vmRepoPath, vmStat, VmRouteError, type VmFilesProvider } from './vm-route.ts';
export type WrittenRepoFile = {path:string; version:string; size:number; contentType:string};
export type PresentedRepoFile = (WrittenRepoFile & {type:'file'; repo:string; repoPath?:string; blob:string; caption?:string});
export function mountTarget(mounts: Mount[], tenant: string, agent: string, raw?: string) {
  const own = mounts.find(m=>m.repo===agentRepoId(tenant,agent));
  const path = normalizePath(raw === undefined ? own?.path ?? '' : raw.startsWith('/') ? raw : (own?.path ?? '') + '/' + raw);
  const mount=mounts.find(m=>path===m.path||path.startsWith(m.path+'/'));
  if (!mount) throw new FileError('Path is not inside a mount',403);
  return { mount, path, inside: normalizePath((mount.subpath??'/')+'/'+path.slice(mount.path.length)) };
}
export async function handleAgentFileRequest(request: Request, env: FileBindings, tenant: string, agent: string, path: string, mounts: Mount[] = [], op: 'api' | 'turn' = 'turn', vmFiles?: VmFilesProvider): Promise<Response> {
  try {
    path=normalizePath(path);
    const t=mountTarget(mounts.filter((m):m is Mount=>'repo' in m),tenant,agent,path);
    if(request.method!=='GET' && t.mount.mode!=='rw') throw new FileError('Mount is read-only',403);
    const ref = t.mount.ref ?? 'main';
    const vm = await resolveVmFiles(env as RepoEnv, { tenant, agent, repo: t.mount.repo, ref }, vmFiles);
    if (vm) return await handleVmFile(request, vm, ref, t, agent);
    const store=await agentStore(env as RepoEnv,tenant,t.mount.repo,t.mount.ref??'main',agent, { ...(request.headers.get("x-camel-run") ? {"Camel-Run":request.headers.get("x-camel-run")!} : {}), ...(request.headers.get("x-camel-call") ? {"Camel-Call":request.headers.get("x-camel-call")!} : {}) }), p=insideRepo(t.inside);
    if(request.method==='GET') {
      const file=await store.stat(t.inside), v=await store.ctx.repo.resolve(file.version);
      const response=await streamFile(request,store.ctx,v,{path:p,blob:file.blob,size:file.size,mode:'100644'});
      const headers=new Headers(response.headers);headers.set('x-file-version',file.version);headers.set('etag',`"${file.version}"`);
      return new Response(response.body,{status:response.status,headers});
    }
    if(request.method==='PUT'||request.method==='DELETE') {
      const header=request.headers.get('if-match')?.replace(/^W\//,'').replaceAll('"','');
      const old=header ? await store.stat(t.inside) : undefined;
      if(old && old.version!==header) throw new FileError('File changed since the version given',412);
      const expected=request.headers.get('if-none-match')==='*' ? 'none' : old?.blob;
      const result=await store.commit({[p]: request.method==='DELETE'?null:{bytes:await boundedBytes(request.body,256*2**20)}},expected?{[p]:expected}:{},`${request.method.toLowerCase()} ${p}`,{},op);
      return Response.json(request.method==='DELETE'?{deleted:true,version:result.version}:{...await store.stat(t.inside,result.version!),path:t.path,version:result.version,by:agent},{status:request.method==='PUT'?201:200});
    }
    throw new FileError('Method not allowed',405);
  } catch(e) {return failure(e);}
}
async function handleVmFile(request: Request, vm: VmFiles, ref: string, t: ReturnType<typeof mountTarget>, agent: string) {
  if (request.method === 'GET') {
    const stat = await vmStat(vm, ref, t.inside), path = vmRepoPath(t.inside);
    const range = request.headers.get('range');
    let offset: number | undefined, length: number | undefined;
    if (range) {
      const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(range);
      check(match, 'bad_range');
      offset = match[3] ? Math.max(0, stat.size - Number(match[3])) : Number(match[1]);
      const end = match[2] ? Math.min(stat.size, Number(match[2]) + 1) : stat.size;
      length = end - offset;
      if (length <= 0 || match[3] === '0')
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${stat.size}` } });
    }
    const read = await vmOperation(ref, () => vm.read(path, range ? { offset, length } : undefined));
    // Range offsets were computed against this version's size.
    if (range && read.sha256 !== stat.sha256) throw new FileError('File changed since the version given', 412);
    const file = vmEntry(t.inside, read, read.bytes);
    const headers = new Headers(downloadHeaders(file.contentType, path));
    headers.set('cache-control', 'no-store');
    headers.set('accept-ranges', 'bytes');
    headers.set('content-length', String(read.bytes.length));
    headers.set('x-blob', file.blob);
    headers.set('x-version', file.version);
    headers.set('x-file-version', file.version);
    headers.set('x-mode', stat.mode);
    headers.set('etag', `"${file.version}"`);
    if (range) headers.set('content-range', `bytes ${offset}-${offset! + read.bytes.length - 1}/${read.size}`);
    return new Response(new Uint8Array(read.bytes), { headers, status: range ? 206 : 200 });
  }
  if (request.method === 'PUT' || request.method === 'DELETE') {
    const path = vmRepoPath(t.inside);
    const header = request.headers.get('if-match')?.replace(/^W\//, '').replaceAll('"', '');
    const old = header ? await vmStat(vm, ref, t.inside) : undefined;
    if (old && old.sha256 !== header) throw new FileError('File changed since the version given', 412);
    const expected = request.headers.get('if-none-match') === '*' ? 'none' : old?.sha256;
    if (request.method === 'DELETE') {
      await vmOperation(ref, () => vm.delete([path], expected ? { expectSha256: { [path]: expected } } : undefined));
      return Response.json({ deleted: true, version: null });
    }
    const bytes = await boundedBytes(request.body, 256 * 2 ** 20);
    const written = await vmOperation(ref, () => vm.write(path, bytes, { expectSha256: expected }));
    return Response.json({ ...vmEntry(t.path, written, bytes), by: agent }, { status: 201 });
  }
  throw new FileError('Method not allowed', 405);
}

function failure(e: unknown) {
  const m = /FILE_(\d{3}):([^]*)/.exec(String(e));
  if (m) return Response.json({ error: m[2] }, { status: Number(m[1]) });
  const error = heldFileError(e) ?? e;
  if (error instanceof VmRouteError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  return repoFailure(error);
}

export async function handleAgentFilesRoute(request: Request, env: FileBindings, tenant: string, agent: string, mounts: Mount[], path = new URL(request.url).pathname, vmFiles?: VmFilesProvider): Promise<Response | null> {
  if(path!=='/files'&&path!=='/links'&&!path.startsWith('/uploads/'))return null;
  try {
    const url=new URL(request.url);
    if(path.startsWith('/uploads/')) {
      const match=/^\/uploads\/([A-Za-z0-9_-]{1,80})\/([^/]+)$/.exec(path);
      if(!match)throw new FileError('Invalid upload path');
      const own=mounts.find(m=>'repo'in m&&m.repo===agentRepoId(tenant,agent)&&m.mode==='rw');
      if(!own)throw new FileError('Attaching files needs a writable mount, like the default /workspace');
      const headers=new Headers(request.headers);headers.set('x-camel-run',match[1]);
      return handleAgentFileRequest(new Request(request,{headers}),env,tenant,agent,`${own.path}/uploads/${match[1]}/${safeName(decodeURIComponent(match[2]))}`,mounts,'turn',vmFiles);
    }
    const body=path==='/links'?await request.clone().json() as any:undefined;
    const asked=body?.path??url.searchParams.get('path')??undefined;
    const t = mountTarget(mounts.filter((m): m is Mount => 'repo' in m), tenant, agent, asked);
    const ref = t.mount.ref ?? 'main';
    if(path==='/links') {
      if(body.method==='PUT'&&t.mount.mode!=='rw')throw new FileError('Mount is read-only',403);
      const store = await agentStore(env as RepoEnv, tenant, t.mount.repo, ref, agent);
      return Response.json({...await signRepoLink(store.ctx,url.origin,{...body,path:insideRepo(t.inside),ref:store.ref,agent,run:request.headers.get("x-camel-run")??undefined,call:request.headers.get("x-camel-call")??undefined}),path:t.path},{status:201});
    }
    const vm = await resolveVmFiles(env as RepoEnv, { tenant, agent, repo: t.mount.repo, ref }, vmFiles);
    const glob = url.searchParams.get('glob') ?? undefined;
    const files = vm ? undefined : await (await agentStore(env as RepoEnv, tenant, t.mount.repo, ref, agent)).list(t.inside, undefined, glob);
    const base = t.mount.subpath ?? '/';
    const show = (p: string) => t.mount.path + (base === '/' ? p : p.slice(base.length));
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 1000)));
    if (!Number.isInteger(limit)) throw new FileError('Invalid limit');
    const after = url.searchParams.get('after') ?? '';
    if (vm) {
      const paths: string[] = [];
      let next: string | undefined;
      for await (const entry of vmList(vm, ref, t.inside, glob)) {
        if (show(entry.path) <= after) continue;
        if (paths.length === limit) {
          next = show(paths[limit - 1]);
          break;
        }
        paths.push(entry.path);
      }
      const stats = paths.length
        ? await vmOperation(ref, () => vm.stat(paths.map(insideRepo))) : {};
      const entries = paths.flatMap(path => {
        const stat = stats[insideRepo(path)];
        return stat ? [{ ...vmEntry(show(path), stat), mode: stat.mode }] : [];
      });
      return Response.json({ files: entries, ...(next ? { next } : {}) });
    }
    const matches = files!.filter(f => show(f.path) > after);
    return Response.json({files:matches.slice(0,limit).map(f=>({...f,path:show(f.path)})),...(matches.length>limit?{next:show(matches[limit-1].path)}:{})});
  }catch(e){return failure(e);}
}
