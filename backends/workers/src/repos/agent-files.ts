import { agentStore, insideRepo, globMatch } from './agent-store.ts';
import { agentRepoId, type AgentMount, type Mount } from './mounts.ts';
import type { FileBindings } from '../files.ts';
import { legacyAgentFileRequest, legacyAgentFilesRoute } from '../files.ts';
import type { RepoEnv } from './registry.ts';
import { FileError, normalizePath } from '../volume.ts';
import { safeName } from '../file-policy.ts';
import { boundedBytes } from '../images.ts';
import { streamFile, repoFailure } from './routes.ts';
import type { RepoTreeCache } from './tree-cache.ts';
import { signRepoLink } from './links.ts';
export type WrittenRepoFile = {path:string; version:string | number; size:number; contentType:string};
export type PresentedRepoFile = (WrittenRepoFile & {type:'file'; repo:string; repoPath?:string; blob:string; caption?:string}) | import('../files.ts').PresentedVolumeFile;
export function mountTarget(mounts: Mount[], tenant: string, agent: string, raw?: string) {
  const own = mounts.find(m=>m.repo===agentRepoId(tenant,agent));
  const path = normalizePath(raw === undefined ? own?.path ?? '' : raw.startsWith('/') ? raw : (own?.path ?? '') + '/' + raw);
  const mount=mounts.find(m=>path===m.path||path.startsWith(m.path+'/'));
  if (!mount) throw new FileError('Path is not inside a mount',403);
  return { mount, path, inside: normalizePath((mount.subpath??'/')+'/'+path.slice(mount.path.length)) };
}
export async function handleAgentFileRequest(request: Request, env: FileBindings, tenant: string, agent: string, path: string, mounts: AgentMount[] = [], op: 'api' | 'turn' = 'turn', cache?: RepoTreeCache): Promise<Response> {
  const scope = cache?.scope();
  try {
    path=normalizePath(path);
    const legacy=mounts.find(m=>!('repo' in m)&&(path===m.path||path.startsWith(m.path+'/')));
    // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
    if (legacy && 'volumeId' in legacy) return legacyAgentFileRequest(request,env,tenant,agent,path,[legacy]);
    const t=mountTarget(mounts.filter((m):m is Mount=>'repo' in m),tenant,agent,path);
    if(request.method!=='GET' && t.mount.mode!=='rw') throw new FileError('Mount is read-only',403);
    const store=await agentStore(env as RepoEnv,tenant,t.mount.repo,t.mount.ref??'main',agent, { ...(request.headers.get("x-camel-run") ? {"Camel-Run":request.headers.get("x-camel-run")!} : {}), ...(request.headers.get("x-camel-call") ? {"Camel-Call":request.headers.get("x-camel-call")!} : {}) }, scope), p=insideRepo(t.inside);
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
  } catch(e) {return failure(e);} finally {scope?.close();}
}
function failure(e:unknown) {const m=/FILE_(\d{3}):([^]*)/.exec(String(e));return m?Response.json({error:m[2]},{status:Number(m[1])}):repoFailure(e);}
export async function handleAgentFilesRoute(request:Request,env:FileBindings,tenant:string,agent:string,mounts:AgentMount[],path=new URL(request.url).pathname, cache?: RepoTreeCache):Promise<Response|null> {
  if(path!=='/files'&&path!=='/links'&&!path.startsWith('/uploads/'))return null;
  const scope = cache?.scope();
  try {
    const url=new URL(request.url);
    if(path.startsWith('/uploads/')) {
      const match=/^\/uploads\/([A-Za-z0-9_-]{1,80})\/([^/]+)$/.exec(path);
      if(!match)throw new FileError('Invalid upload path');
      // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
      if (!mounts.some(m=>'repo'in m && m.repo===agentRepoId(tenant,agent)&&m.mode==='rw')) {
        const legacy=mounts.filter((m):m is import('../files.ts').LegacyVolumeMount=>'volumeId'in m);
        if(legacy.length) return legacyAgentFilesRoute(request,env,tenant,agent,legacy,path);
      }
      const own=mounts.find(m=>'repo'in m&&m.repo===agentRepoId(tenant,agent)&&m.mode==='rw');
      if(!own)throw new FileError('Attaching files needs a writable mount, like the default /workspace');
      const headers=new Headers(request.headers);headers.set('x-camel-run',match[1]);
      return handleAgentFileRequest(new Request(request,{headers}),env,tenant,agent,`${own.path}/uploads/${match[1]}/${safeName(decodeURIComponent(match[2]))}`,mounts,'turn',cache);
    }
    const body=path==='/links'?await request.clone().json() as any:undefined;
    const asked=body?.path??url.searchParams.get('path')??undefined;
    const legacy=mounts.find(m=>!('repo'in m)&&(asked ? asked===m.path||asked.startsWith(m.path+'/') : !mounts.some(m=>'repo'in m)));
    // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
    if(legacy&&'volumeId'in legacy)return legacyAgentFilesRoute(request,env,tenant,agent,[legacy],path);
    const t=mountTarget(mounts.filter((m):m is Mount=>'repo'in m),tenant,agent,asked), store=await agentStore(env as RepoEnv,tenant,t.mount.repo,t.mount.ref??'main',agent,{},scope);
    if(path==='/links') {
      if(body.method==='PUT'&&t.mount.mode!=='rw')throw new FileError('Mount is read-only',403);
      return Response.json({...await signRepoLink(store.ctx,url.origin,{...body,path:insideRepo(t.inside),ref:store.ref,agent,run:request.headers.get("x-camel-run")??undefined,call:request.headers.get("x-camel-call")??undefined}),path:t.path},{status:201});
    }
    const files=await store.list(t.inside,undefined,url.searchParams.get('glob')??undefined),base=t.mount.subpath??'/',show=(p:string)=>t.mount.path+(base==='/'?p:p.slice(base.length));
    const limit=Math.min(1000,Math.max(1,Number(url.searchParams.get('limit')??1000)));
    if(!Number.isInteger(limit))throw new FileError('Invalid limit');
    const matches=files.filter(f=>show(f.path)>(url.searchParams.get('after')??''));
    return Response.json({files:matches.slice(0,limit).map(f=>({...f,path:show(f.path)})),...(matches.length>limit?{next:show(matches[limit-1].path)}:{})});
  }catch(e){return failure(e);} finally {scope?.close();}
}
