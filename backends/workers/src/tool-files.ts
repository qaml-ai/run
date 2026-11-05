import { Buffer } from 'node:buffer';
import { TOOL_FILE_LIMITS } from '../../../src/limits.ts';
import { tar } from '../../../src/tar.ts';
import { volume, handleAgentFileRequest, type FileBindings, type Mount } from './files.ts';
import { normalizePath, type FileEntry } from './volume.ts';
import { downloadHeaders, safeName } from './file-policy.ts';
import { runtimeSigner, type IdentityEnv } from './tool-identity.ts';
import type { FileGrant } from './runtime-identity.ts';
import { HttpError } from './errors.ts';
import type { AttachedFile } from './attachment-markers.ts';
import type { McpResult } from './attached-tools.ts';
import { isFileArgument, type FileSpec, type FileValue } from './tool-file-schema.ts';

type Env = FileBindings & IdentityEnv;
type Scope = { tenant: string; agent: string; mounts: Mount[]; tool: string; call: string; origin: string; refuse?: string; reference(path: string): Promise<AttachedFile>; onWrite(file: { path: string; version: number; size: number; contentType: string }): Promise<void>; budget?: { left: number } };
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const relative = (path: string, root: string) => path.slice(root === '/' ? 1 : root.length + 1);
const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^FILE_\d{3}:/, '') : String(error);
const status = (error: unknown) => error instanceof HttpError ? error.status : Number(/FILE_(\d{3}):/.exec(String(error))?.[1]);

/** One call's mount-limited transport. The volume owns ordering; R2 owns immutable bytes. */
export class ToolFiles {
  private left = TOOL_FILE_LIMITS.callBytes;
  private directory?: string;
  private names = new Set<string>();
  constructor(private env: Env, private scope: Scope) {}
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
    const target = this.target(path), v = await volume(this.env, this.scope.tenant, target.mount.volumeId);
    let entry: FileEntry;
    try { entry = await v.stat(target.path); }
    catch (error) {
      if (status(error) !== 404) throw error;
      if ((await v.list(target.path)).length) throw new Error(`${target.shown} is a directory`);
      throw new Error(`${target.shown} does not exist`);
    }
    return { ...target, entry, name: nameOf(target.path), size: entry.size, contentType: entry.contentType };
  }
  private async bytes(file: Awaited<ReturnType<ToolFiles['open']>>) {
    const object = await this.env.BUCKET.get(file.entry.key);
    if (!object) throw new Error(`${file.shown} no longer exists`);
    return Buffer.from(await object.arrayBuffer());
  }
  async read(path: string) {
    const file = await this.open(path);
    if (file.size > TOOL_FILE_LIMITS.inlineBytes) throw new Error(`${file.shown} is ${file.size} bytes; at most ${TOOL_FILE_LIMITS.inlineBytes} can be sent inline`);
    return this.bytes(file);
  }
  private async signed(grant: Pick<FileGrant, 'volume'|'path'|'agentPath'|'kind'|'snapshot'|'version'>, name: string) {
    return fileUrl(this.env, this.scope.origin, { tenant: this.scope.tenant, agent: this.scope.agent, tool: this.scope.tool, call: this.scope.call, ...grant }, name, Date.now() + TOOL_FILE_LIMITS.urlSeconds * 1000);
  }
  async send(path: string, directory: boolean, spec: FileSpec, describe: boolean): Promise<{ uri: string; value?: FileValue }> {
    if (directory) {
      const target = this.target(path), v = await volume(this.env, this.scope.tenant, target.mount.volumeId);
      try { await v.stat(target.path); throw new Error(`${target.shown} is a file; this argument takes a directory`); }
      catch (error) { if (status(error) !== 404) throw error; }
      const entries = await v.list(target.path);
      if (!entries.length) throw new Error(`${target.shown} does not exist`);
      if (entries.length > TOOL_FILE_LIMITS.directoryFiles || entries.reduce((sum, file) => sum + file.size, 0) > TOOL_FILE_LIMITS.directoryBytes)
        throw new Error(`a directory sent to a tool has at most ${TOOL_FILE_LIMITS.directoryFiles} files and ${TOOL_FILE_LIMITS.directoryBytes} bytes`);
      const snapshot = await v.snapshot(`[tool-call]${this.scope.call}`.slice(0,120), { given: entries, expiresAt: Date.now() + TOOL_FILE_LIMITS.urlSeconds * 1000 });
      // A temporary snapshot remains reachable for the link's lifetime and is hidden from public listings.
      return { uri: await this.signed({ volume: target.mount.volumeId, path: target.path, agentPath: target.shown, kind: 'manifest', snapshot: snapshot.id }, `${nameOf(target.shown)}.json`) };
    }
    const file = await this.open(path);
    if (spec.accept && !spec.accept.some(pattern => { const [a,b] = pattern.split(';')[0].trim().toLowerCase().split('/'); const [c,d] = file.contentType.split('/'); return (a === '*' || a === c) && (b === '*' || b === d); })) throw new Error(`${file.shown} is ${file.contentType}; this argument takes ${spec.accept.join(', ')}`);
    if (spec.maxSize !== undefined && file.size > spec.maxSize) throw new Error(`${file.shown} is ${file.size} bytes; this argument takes at most ${spec.maxSize}`);
    const inline = spec.transferModes?.includes('inline'), url = !spec.transferModes || spec.transferModes.includes('url');
    let uri: string;
    if (inline && file.size <= TOOL_FILE_LIMITS.inlineBytes) uri = `data:${file.contentType};base64,${(await this.bytes(file)).toString('base64')}`;
    else if (url) uri = await this.signed({ volume: file.mount.volumeId, path: file.path, agentPath: file.shown, kind: 'file', version: file.entry.version }, file.name);
    else throw new Error(`${file.shown} is ${file.size} bytes; this argument takes files inline only, at most ${TOOL_FILE_LIMITS.inlineBytes}`);
    const hash = file.entry.sha256 ?? (file.size <= TOOL_FILE_LIMITS.digestBytes ? await crypto.subtle.digest('SHA-256', await this.bytes(file)).then(data => Buffer.from(data).toString('hex')) : undefined);
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
    const response = await handleAgentFileRequest(new Request('https://agent.invalid/files', { method: 'PUT', headers: contentType ? { 'Content-Type': contentType } : {}, body }), this.env, this.scope.tenant, this.scope.agent, path, this.scope.mounts);
    const saved = await response.json() as any;
    if (!response.ok) throw new Error(saved.error ?? 'Tool output could not be saved');
    this.left -= saved.size; if (this.scope.budget) this.scope.budget.left -= saved.size;
    await this.scope.onWrite({ path, version: saved.version, size: saved.size, contentType: saved.contentType });
    return this.scope.reference(path);
  }
  async bodyFile(input: unknown) {
    if (!isFileArgument(input)) throw new Error('A binary request body needs {$file: path}');
    const file = await this.open(input.$file);
    const object = await this.env.BUCKET.get(file.entry.key);
    if (!object) throw new Error(`${file.shown} no longer exists`);
    return { ...file, stream: object.body };
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
  const v = await volume(env, grant.tenant, grant.volume);
  let files: FileEntry[];
  try { files = grant.kind === 'file' ? [await v.stat(grant.path, grant.snapshot)] : await v.list(grant.path, grant.snapshot); }
  catch (error) { if (status(error) === 404) throw new HttpError(410, grant.snapshot ? "The call's files are no longer kept" : `${grant.agentPath} no longer exists`); throw error; }
  if (grant.kind === 'manifest') {
    const entries = await Promise.all(files.map(async file => ({ path: relative(file.path, grant.path), uri: await fileUrl(env, url.origin, { ...grant, kind: 'file', path: file.path, agentPath: `${grant.agentPath}/${relative(file.path, grant.path)}` }, nameOf(file.path), grant.exp * 1000), name: nameOf(file.path), mimeType: file.contentType, size: file.size, ...(file.sha256 ? { digest: { algorithm: 'sha-256', value: file.sha256 } } : {}) })));
    return Response.json({ snapshot: grant.snapshot, root: grant.agentPath, files: entries, archive: { uri: await fileUrl(env,url.origin,{...grant,kind:'archive'},`${nameOf(grant.path)}.tar.gz`,grant.exp * 1000), mimeType:'application/gzip' } });
  }
  if (grant.kind === 'archive') {
    const archive = tar(files.map(file => ({ name: relative(file.path,grant.path), size:file.size, mtime:file.updatedAt, stream: async function* () { const object = await env.BUCKET.get(file.key); if (!object) throw new Error('File object missing'); for await (const chunk of object.body) yield chunk; } })));
    const body = new ReadableStream<Uint8Array>({ async pull(controller) { const next = await archive.next(); if (next.done) controller.close(); else controller.enqueue(new Uint8Array(next.value)); }, async cancel() { await archive.return(undefined); } }).pipeThrough(new CompressionStream('gzip'));
    return new Response(body, { headers: downloadHeaders('application/gzip',`${nameOf(grant.path)}.tar.gz`) });
  }
  const file = files[0];
  if (grant.version !== undefined && grant.version !== file.version) throw new HttpError(410, `${grant.agentPath} changed since the call`);
  const range = request.headers.get('range');
  const matchRange = range && /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = matchRange ? Number(matchRange[1]) : 0, end = matchRange?.[2] ? Math.min(Number(matchRange[2]),file.size-1) : file.size-1;
  if (range && (!matchRange || start > end)) return new Response(null,{status:416,headers:{'content-range':`bytes */${file.size}`}});
  const object = await env.BUCKET.get(file.key, range ? { range: {offset:start,length:end-start+1} } : undefined);
  if (!object) throw new HttpError(503,'File object missing');
  return new Response(object.body, { status: range ? 206 : 200, headers: { 'Content-Type': file.contentType, 'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store', ...(range ? {'Content-Range':`bytes ${start}-${end}/${file.size}`} : {}) } });
}

const named = (kind: string, index: number, type: unknown) => `${kind}-${index}${typeof type === 'string' && /^[a-z]+\/[a-z0-9]+/i.test(type) ? '.' + /^[a-z]+\/([a-z0-9]+)/i.exec(type)![1].toLowerCase() : ''}`;
const resourceName = (uri: unknown, index: number, type: unknown) => { try { return decodeURIComponent(new URL(String(uri)).pathname.split('/').pop()!) || named('resource',index,type); } catch { return named('resource',index,type); } };
export async function savedContent(result: McpResult, files?: ToolFiles, fetcher?: (url: string) => Promise<Response>): Promise<McpResult> {
  if (!Array.isArray(result.content)) return result;
  const content: any[] = []; let index=0;
  for (const part of result.content as any[]) {
    if (part?.type === 'file') { content.push({type:'text',text:'[file content omitted]'}); continue; }
    if (fetcher && files && part?.type === 'resource_link' && typeof part.uri === 'string' && /^(https?|data):/i.test(part.uri)) {
      const label = typeof part.name === 'string' ? part.name : 'linked file'; index++;
      try { const inline = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(part.uri); const response = inline ? undefined : await fetcher(part.uri); if (response && !response.ok) throw new Error(`fetching it answered HTTP ${response.status}`); content.push(await files.save(typeof part.name === 'string' ? part.name : resourceName(part.uri,index,part.mimeType), inline ? Buffer.from(inline[3],inline[2] ? 'base64' : 'utf8') : response!.body as any, part.mimeType ?? inline?.[1] ?? response?.headers.get('content-type') ?? undefined)); }
      catch (error) { content.push({type:'text',text:`[${label} not saved: ${errorText(error)}]`}); }
      continue;
    }
    const resource = part?.type === 'resource' ? part.resource : undefined;
    let output: {name:string;bytes:Buffer;type?:string}|undefined;
    if ((part?.type === 'image' || part?.type === 'audio') && typeof part.data === 'string') output={name:named(part.type,++index,part.mimeType),bytes:Buffer.from(part.data,'base64'),type:part.mimeType};
    else if (typeof resource?.blob === 'string') output={name:resourceName(resource.uri,++index,resource.mimeType),bytes:Buffer.from(resource.blob,'base64'),type:resource.mimeType};
    else if (typeof resource?.text === 'string' && Buffer.byteLength(resource.text)>TOOL_FILE_LIMITS.textBytes) output={name:resourceName(resource.uri,++index,resource.mimeType),bytes:Buffer.from(resource.text),type:resource.mimeType??'text/plain'};
    if (!output || !files) { content.push(part); continue; }
    try { content.push(await files.save(output.name,output.bytes,output.type)); }
    catch (error) { content.push(part.type==='image'||typeof resource?.text==='string'?part:{type:'text',text:`[${part.type} content not saved: ${errorText(error)}]`}); }
  }
  return {...result,content};
}

/** Stream multipart bodies with a known length, retaining each file's name and MIME. */
export async function multipartBody(value: unknown, files: ToolFiles) {
  const boundary = `camelrun-${crypto.randomUUID()}`;
  const parts: (Uint8Array | ReadableStream<Uint8Array>)[] = []; let length = 0;
  const text = (value: string) => { const bytes = new TextEncoder().encode(value); parts.push(bytes); length += bytes.byteLength; };
  const append = async (name: string, value: unknown) => {
    if (Array.isArray(value)) { for (const item of value) await append(name, item); return; }
    const field = name.replace(/[\r\n"\\]/g, '_');
    if (isFileArgument(value)) {
      const file = await files.bodyFile(value);
      text(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${file.name.replace(/[\r\n"\\]/g, '_')}"\r\nContent-Type: ${file.contentType}\r\n\r\n`);
      parts.push(file.stream); length += file.size; text('\r\n');
    } else text(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${typeof value === 'object' ? JSON.stringify(value) : String(value)}\r\n`);
  };
  for (const [name, entry] of Object.entries(value as object)) await append(name, entry);
  text(`--${boundary}--\r\n`);
  let index = 0, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    while (index < parts.length) { const part = parts[index]; if (part instanceof Uint8Array) { index++; controller.enqueue(part); return; }
      reader ??= part.getReader(); const next = await reader.read(); if (!next.done) { controller.enqueue(next.value); return; } reader.releaseLock(); reader = undefined; index++; }
    controller.close();
  }, async cancel() { await reader?.cancel(); } });
  return { body, length, contentType: `multipart/form-data; boundary=${boundary}` };
}
