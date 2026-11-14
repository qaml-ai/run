import { LegacyToolFiles, serveLegacyToolFile } from "./legacy-tool-files.ts";
import { agentStore, insideRepo } from "./repos/agent-store.ts";
import { repoContext, type RepoEnv } from "./repos/registry.ts";
import { versionEntries } from "./repos/reads.ts";
import { readAttachment } from "./repos/attachments.ts";
import { Buffer } from 'node:buffer';
import { TOOL_FILE_LIMITS } from '../../../src/limits.ts';
import { tar } from '../../../src/tar.ts';
import { volume, handleAgentFileRequest, type FileBindings, type Mount } from './files.ts';
import { normalizePath } from './volume.ts';
import { downloadHeaders, safeName } from './file-policy.ts';
import { runtimeSigner, type IdentityEnv } from './tool-identity.ts';
import type { FileGrant } from './runtime-identity.ts';
import { HttpError } from './errors.ts';
import type { AttachedFile } from './attachment-markers.ts';
import { isFileArgument, type FileSpec, type FileValue } from './tool-file-schema.ts';

type Env = FileBindings & IdentityEnv;
type Scope = { tenant: string; agent: string; mounts: import("./repos/mounts.ts").AgentMount[]; tool: string; call: string; requestId?:string; origin: string; refuse?: string; reference(path: string): Promise<AttachedFile>; onWrite(file: { path: string; version: string; size: number; contentType: string }): Promise<void>; budget?: { left: number } };
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const relative = (path: string, root: string) => root?path.slice(root === '/' ? 1 : root.length + 1):path;
const status = (error: unknown) => error instanceof HttpError ? error.status : Number(/FILE_(\d{3}):/.exec(String(error))?.[1]);

/** One call's mount-limited transport. The repo orders writes and keeps immutable versions. */
class RepoToolFiles {
  private left = TOOL_FILE_LIMITS.callBytes;
  private directory?: string;
  private names = new Set<string>();
  constructor(private env: Env, private scope: Omit<Scope,'mounts'> & {mounts:Mount[]}) {}
  private target(input: string) {
    if (this.scope.refuse) throw new Error(this.scope.refuse);
    const mounts = this.scope.mounts;
    if (!mounts.length) throw new Error('This agent has no volumes mounted');
    const path = normalizePath(input.startsWith('/') ? input : `${mounts[0].path}/${input}`);
    if (path === '/') throw new Error('$file names a file, not /');
    const mount = mounts.find(m => path === m.path || path.startsWith(m.path + '/'));
    if (!mount) throw new Error(`${path} is not inside a mount. Mounted: ${mounts.map(m => m.path).join(', ')}`);
    return { mount, shown: path, path: normalizePath((mount.subpath ?? '/') + '/' + path.slice(mount.path.length)) };
  }
  async open(path: string) {
    const target = this.target(path), v = await agentStore(this.env as RepoEnv, this.scope.tenant, target.mount.repo, target.mount.ref??"main", this.scope.agent);
    let entry: Awaited<ReturnType<typeof v.stat>>;
    try { entry = await v.stat(target.path); }
    catch (error) {
      if (status(error) !== 404) throw error;
      if ((await v.list(target.path)).length) throw new Error(`${target.shown} is a directory`);
      throw new Error(`${target.shown} does not exist`);
    }
    return { ...target, entry, name: nameOf(target.path), size: entry.size, contentType: entry.contentType };
  }
  private async bytes(file: Awaited<ReturnType<RepoToolFiles['open']>>) {
    const ctx=await repoContext(this.env as RepoEnv,this.scope.tenant,file.mount.repo), v=await ctx.repo.resolve(file.entry.version);
    return Buffer.from(await ctx.storage.readBlob(ctx.lineage,file.entry.blob,v.tree,insideRepo(file.path)));
  }
  async read(path: string) {
    const file = await this.open(path);
    if (file.size > TOOL_FILE_LIMITS.inlineBytes) throw new Error(`${file.shown} is ${file.size} bytes; at most ${TOOL_FILE_LIMITS.inlineBytes} can be sent inline`);
    return this.bytes(file);
  }
  private async signed(grant: Pick<FileGrant, 'repo'|'path'|'agentPath'|'kind'|'version'>, name: string) {
    return fileUrl(this.env, this.scope.origin, { tenant: this.scope.tenant, agent: this.scope.agent, tool: this.scope.tool, call: this.scope.call, ...grant }, name, Date.now() + TOOL_FILE_LIMITS.urlSeconds * 1000);
  }
  async send(path: string, directory: boolean, spec: FileSpec, describe: boolean): Promise<{ uri: string; value?: FileValue }> {
    if (directory) {
      const target = this.target(path), v = await agentStore(this.env as RepoEnv, this.scope.tenant, target.mount.repo, target.mount.ref??"main", this.scope.agent);
      try { await v.stat(target.path); throw new Error(`${target.shown} is a file; this argument takes a directory`); }
      catch (error) { if (status(error) !== 404) throw error; }
      const entries = await v.list(target.path);
      if (!entries.length) throw new Error(`${target.shown} does not exist`);
      if (entries.length > TOOL_FILE_LIMITS.directoryFiles || entries.reduce((sum, file) => sum + file.size, 0) > TOOL_FILE_LIMITS.directoryBytes)
        throw new Error(`a directory sent to a tool has at most ${TOOL_FILE_LIMITS.directoryFiles} files and ${TOOL_FILE_LIMITS.directoryBytes} bytes`);
      const head=await v.ctx.repo.resolve(entries[0].version);
      return {uri:await this.signed({repo:target.mount.repo,path:insideRepo(target.path),agentPath:target.shown,kind:'archive',version:head.version},`${nameOf(target.shown)}.tar.gz`)};
    }
    const file = await this.open(path);
    if (spec.accept && !spec.accept.some(pattern => { const [a,b] = pattern.split(';')[0].trim().toLowerCase().split('/'); const [c,d] = file.contentType.toLowerCase().split('/'); return (a === '*' || a === c) && (b === '*' || b === d); })) throw new Error(`${file.shown} is ${file.contentType}; this argument takes ${spec.accept.join(', ')}`);
    if (spec.maxSize !== undefined && file.size > spec.maxSize) throw new Error(`${file.shown} is ${file.size} bytes; this argument takes at most ${spec.maxSize}`);
    const inline = spec.transferModes?.includes('inline'), url = !spec.transferModes || spec.transferModes.includes('url');
    let uri: string;
    if (inline && file.size <= TOOL_FILE_LIMITS.inlineBytes) uri = `data:${file.contentType};base64,${(await this.bytes(file)).toString('base64')}`;
    else if (url) uri = await this.signed({ repo: file.mount.repo, path: insideRepo(file.path), agentPath: file.shown, kind: 'file', version: file.entry.version }, file.name);
    else throw new Error(`${file.shown} is ${file.size} bytes; this argument takes files inline only, at most ${TOOL_FILE_LIMITS.inlineBytes}`);
    const hash = (file.size <= TOOL_FILE_LIMITS.digestBytes ? await crypto.subtle.digest('SHA-256', await this.bytes(file)).then(data => Buffer.from(data).toString('hex')) : undefined);
    return { uri, ...(describe ? { value: { uri, name: file.name, mimeType: file.contentType, size: file.size, ...(hash ? { digest: { algorithm: 'sha-256' as const, value: hash } } : {}) } } : {}) };
  }
  get hasWorkspace() { return this.scope.mounts.some(m => m.mode === 'rw'); }
  async save(name: string, source: Uint8Array | AsyncIterable<Uint8Array>, contentType?: string): Promise<AttachedFile> {
    const mount = this.scope.mounts.find(m => m.path === '/workspace' && m.mode === 'rw') ?? this.scope.mounts.find(m => m.mode === 'rw');
    if (!mount) throw new Error('this agent has no writable mount to save it to');
    this.directory ??= `${mount.path}/tool-outputs/${safeName(this.scope.tool, 'tool')}/${crypto.randomUUID().replaceAll('-','').slice(0,8)}`;
    const base = safeName(name, 'output'); let unique = base;
    for (let n = 2; this.names.has(unique); n++) unique = base.replace(/(\.[^.]*)?$/, suffix => `-${n}${suffix}`);
    this.names.add(unique);
    let size = 0; const budget = Math.min(this.left, this.scope.budget?.left ?? Infinity);
    const iterator = source instanceof Uint8Array ? (async function* () { yield source; })() : source[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({ async pull(controller) { const next = await iterator.next(); if (next.done) return controller.close(); size += next.value.byteLength; if (size > budget) { await iterator.return?.(); return controller.error(new Error(`it is larger than the ${budget} bytes the tool may still save`)); } controller.enqueue(next.value); }, async cancel() { await iterator.return?.(); } });
    const path = `${this.directory}/${unique}`;
    const response = await handleAgentFileRequest(new Request('https://agent.invalid/files', { method: 'PUT', headers: { ...(contentType ? { 'Content-Type': contentType } : {}), 'x-camel-call': this.scope.call,...(this.scope.requestId?{'x-camel-run':this.scope.requestId}:{}) }, body }), this.env, this.scope.tenant, this.scope.agent, path, this.scope.mounts);
    const saved = await response.json() as any;
    if (!response.ok) throw new Error(saved.error ?? 'Tool output could not be saved');
    this.left -= saved.size; if (this.scope.budget) this.scope.budget.left -= saved.size;
    await this.scope.onWrite({ path, version: saved.version, size: saved.size, contentType: saved.contentType });
    return this.scope.reference(path);
  }
  async bodyFile(input: unknown) {
    if (!isFileArgument(input)) throw new Error('A binary request body needs {$file: path}');
    const file = await this.open(input.$file);
    const ctx=await repoContext(this.env as RepoEnv,this.scope.tenant,file.mount.repo), v=await ctx.repo.resolve(file.entry.version);
    const response=await ctx.storage.openBlob(ctx.lineage,file.entry.blob,v.tree,insideRepo(file.path));
    return {...file,stream:response.body!};
  }
}

async function fileUrl(env: Env, origin: string, grant: FileGrant, name: string, expiresAt: number) {
  const token = await (await runtimeSigner(env, origin)).fileToken(grant, expiresAt);
  return `${origin.replace(/\/+$/, '')}/v1/files/${token}/${encodeURIComponent(name || 'file')}`;
}
/** Call-bound tokens use the runtime's EdDSA identity key, not the browser upload-link secret. */
export async function serveToolFile(request: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(request.url), match = /^\/v1\/files\/([^/]+)\/[^/]+$/.exec(url.pathname);
  if (!match || match[1].split('.').length === 2) return;
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const grant = await (await runtimeSigner(env, url.origin)).verifyFileToken(match[1]);
  // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
  if('volume' in grant)return serveLegacyToolFile(request,env);
  const ctx=await repoContext(env as RepoEnv,grant.tenant,grant.repo), v=await ctx.repo.resolve(grant.version);
  const entries=(await versionEntries(ctx,v.tree)).filter(e=>!grant.path||e.path===grant.path||e.path.startsWith(grant.path+'/'));
  if(grant.kind==='archive') {
    const archive=tar(entries.map(file=>({name:relative(file.path,grant.path),size:file.size,mtime:0,async *stream(){yield await ctx.storage.readBlob(ctx.lineage,file.blob,v.tree,file.path);}})));
    const body=new ReadableStream<Uint8Array>({async pull(c){const n=await archive.next();if(n.done)c.close();else c.enqueue(new Uint8Array(n.value));},async cancel(){await archive.return(undefined);}}).pipeThrough(new CompressionStream('gzip'));
    return new Response(body,{headers:downloadHeaders('application/gzip',`${nameOf(grant.path)}.tar.gz`)});
  }
  const file=entries.find(e=>e.path===grant.path);
  if(!file)throw new HttpError(410,'File missing');
  const {streamFile}=await import('./repos/routes.ts');
  return streamFile(request,ctx,v,file);

}

export { savedContent } from "./tool-content.ts";

export { multipartBody } from "./tool-multipart.ts";

// TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
export class ToolFiles extends RepoToolFiles {
  private legacy: LegacyToolFiles;
  constructor(env:Env,private original:Scope) {super(env,{...original,mounts:original.mounts.filter((m):m is Mount=>'repo'in m)});this.legacy=new LegacyToolFiles(env,{...original,mounts:original.mounts.filter(m=>'volumeId'in m)} as never);}
  override get hasWorkspace() {return this.original.mounts.some(m=>m.mode==='rw');}
  private usesLegacy(path:string) {const absolute=path.startsWith('/')?path:`${this.original.mounts[0]?.path}/${path}`;return this.original.mounts.some(m=>'volumeId'in m&&(absolute===m.path||absolute.startsWith(m.path+'/')));}
  override open(path:string):ReturnType<RepoToolFiles['open']> {return this.usesLegacy(path)?this.legacy.open(path) as never:super.open(path);}
  override read(path:string) {return this.usesLegacy(path)?this.legacy.read(path):super.read(path);}
  override send(path:string,directory:boolean,spec:FileSpec,describe:boolean) {return this.usesLegacy(path)?this.legacy.send(path,directory,spec,describe):super.send(path,directory,spec,describe);}
  override save(name:string,source:Uint8Array|AsyncIterable<Uint8Array>,contentType?:string) {return 'volumeId' in (this.original.mounts.find(m=>m.path==='/workspace'&&m.mode==='rw')??this.original.mounts.find(m=>m.mode==='rw')??{})?this.legacy.save(name,source,contentType):super.save(name,source,contentType);}
  override bodyFile(input:unknown):ReturnType<RepoToolFiles['bodyFile']> {return isFileArgument(input)&&this.usesLegacy(input.$file)?this.legacy.bodyFile(input) as never:super.bodyFile(input);}
}
