import { Buffer } from "node:buffer";
import { TOOL_FILE_LIMITS } from "../../../src/limits.ts";
import type { ToolFiles } from "./tool-files.ts";
import type { McpResult } from "./attached-tools.ts";

const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^FILE_\d{3}:/, "") : String(error);

const named = (kind: string, index: number, type: unknown) => `${kind}-${index}${typeof type === 'string' && /^[a-z]+\/[a-z0-9]+/i.test(type) ? '.' + /^[a-z]+\/([a-z0-9]+)/i.exec(type)![1].toLowerCase() : ''}`;
const resourceName = (uri: unknown, index: number, type: unknown) => { try { return decodeURIComponent(new URL(String(uri)).pathname.split('/').pop()!) || named('resource',index,type); } catch { return named('resource',index,type); } };
export async function savedContent(result: McpResult, files?: ToolFiles, fetcher?: (url: string) => Promise<Response>): Promise<McpResult> {
  if (!Array.isArray(result.content)) return result;
  const content: any[] = []; let index=0;
  for (const part of result.content as any[]) {
    if (part?.type === 'file') { content.push({type:'text',text:'[file content omitted]'}); continue; }
    if (fetcher && files && part?.type === 'resource_link' && typeof part.uri === 'string' && /^(https?|data):/i.test(part.uri)) {
      const label = typeof part.name === 'string' ? part.name : 'linked file'; index++;
      try { const inline = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/is.exec(part.uri); const response = inline ? undefined : await fetcher(part.uri); if (response && !response.ok) throw new Error(`fetching it answered HTTP ${response.status}`); content.push(await files.save(typeof part.name === 'string' ? part.name : resourceName(part.uri,index,part.mimeType), inline ? (inline[2].split(';').includes('base64') ? Buffer.from(inline[3], 'base64') : Buffer.from(decodeURIComponent(inline[3]))) : response!.body as any, part.mimeType ?? inline?.[1] ?? response?.headers.get('content-type') ?? undefined)); }
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

