import { agentRepoId } from "./repos/identity.ts";
import { Buffer } from 'node:buffer';
import { TOOL_FILE_LIMITS } from '../../../src/limits.ts';
import { digest } from './api-contract.ts';
import { safeName } from './file-policy.ts';
import type { FileBindings, Mount as Mount } from './files.ts';
import { scratchMount } from './media/files-policy.ts';
import type { WebFiles } from './web-policy-host.ts';

/** Files returned by a tool share the repo writer and the source's per-call cap. */
export async function toolResultFiles(env: FileBindings, scope: { tenant: string; agent: string; mounts: Mount[]; tool: string; call: string; requestId?:string }): Promise<WebFiles | undefined> {
  const own = agentRepoId(scope.tenant, scope.agent);
  const mount = scratchMount(scope.mounts.map(value => ({ ...value, workspace: value.repo === own })));
  if (!mount) return;
  const directory = `${mount.path}/tool-outputs/${safeName(scope.tool, 'tool')}/${(await digest(scope.call)).slice(0, 8)}`;
  let left = TOOL_FILE_LIMITS.callBytes;
  const names = new Set<string>();
  return { async save(name, source, contentType) {
    const base = safeName(name, 'output'); let unique = base;
    for (let n = 2; names.has(unique); n++) unique = base.replace(/(\.[^.]*)?$/, extension => `-${n}${extension}`);
    names.add(unique);
    const iterator = source[Symbol.asyncIterator](); let size = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) { controller.close(); return; }
        size += next.value.byteLength;
        if (size > left) { await iterator.return?.(); controller.error(new Error(`The tool has saved as much as it may (${TOOL_FILE_LIMITS.callBytes} bytes a call)`)); return; }
        controller.enqueue(next.value);
      },
      async cancel() { await iterator.return?.(); },
    });
    const path = `${directory}/${unique}`;
    const { handleAgentFileRequest } = await import('./files.ts');
    const response = await handleAgentFileRequest(new Request('https://agent.invalid/files', { method: 'PUT', headers: { 'Content-Type': contentType, 'x-camel-call':scope.call,...(scope.requestId?{'x-camel-run':scope.requestId}:{}) }, body }), env, scope.tenant, scope.agent, path, scope.mounts);
    const saved = await response.json() as { size: number; version: string; contentType: string; error?: string };
    if (!response.ok) throw new Error(saved.error ?? 'Tool output could not be saved');
    left -= saved.size;
    return { type: 'text', text: `[File ${path} (${saved.contentType}, ${saved.size} bytes)]`, path, size: saved.size, version: saved.version, contentType: saved.contentType };
  } };
}

/** Keep Pi's native image block; saving adds its ordinary workspace reference. */
export async function saveToolImages(output: any[], files?: WebFiles): Promise<any[]> {
  if (!files) return output;
  const result: any[] = []; let index = 0;
  for (const part of output) {
    result.push(part);
    if (part.type !== 'image' || typeof part.data !== 'string' || typeof part.mimeType !== 'string') continue;
    const name = `image-${++index}.${/^[a-z]+\/([a-z0-9]+)/i.exec(part.mimeType)?.[1].toLowerCase() ?? 'bin'}`;
    const bytes = Buffer.from(part.data, 'base64');
    try { result.push(await files.save(name, (async function* () { yield bytes; })(), part.mimeType)); }
    catch { /* The original image stays available when its workspace copy cannot be saved. */ }
  }
  return result;
}
