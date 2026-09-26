import { randomBytes } from "node:crypto";
import { errorText } from "./protocol.ts";
import { safeName, type FileLinks, type FileRef } from "./files.ts";
import { fileRef } from "./inspect.ts";
import { TOOL_FILE_LIMITS } from "./limits.ts";
import type { McpResult } from "./mcp-results.ts";
import { resolve, type ToolContext } from "./volume-tools.ts";
import type { Mount, VolumeService } from "./volumes.ts";

/**
 * Files through the calls of tool sources (MCP servers, OpenAPI operations, web_fetch), without
 * their bytes passing through the model.
 *
 * In: an argument `{"$file": "/workspace/report.pdf"}` names a file in the agent's mounts. Where a
 * tool's schema has a string field for a file, the model is offered this form too (`acceptFiles`),
 * and the runtime fills it in from the schema (`resolveFiles`): base64 content for a base64 field
 * (`contentEncoding: base64`, OpenAPI's `format: byte`/`binary`), or else a signed GET link to it (a
 * `format: uri` field, or one named like a URL). An OpenAPI multipart or binary body streams the
 * file instead (openapi.ts). The marker is explicit, so nothing is guessed from a plain string, and
 * it reads the same from a direct call and from js_exec.
 *
 * Out: images, audio, blobs and long text an MCP tool returns, and binary responses, are saved to
 * the agent's workspace under tool-outputs/<tool>/<call>/<name>; the model gets a file reference
 * (path, type, size, and the file natively when it can view it). A call and a run may save only so
 * much (TOOL_FILE_LIMITS), and what they save counts toward the volume like any file.
 */
export type FileArgument = { $file: string };
export const isFileArgument = (value: unknown): value is FileArgument =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as FileArgument).$file === "string";

type Mode = "base64" | "url";
const URL_FORMATS = ["uri", "url", "iri", "uri-reference", "iri-reference"];

/** How a string field takes a file, if it does: its content as base64, or a link to it. */
export function fileMode(schema: any, name?: string): Mode | undefined {
  if (!schema || typeof schema !== "object" || ![schema.type].flat().includes("string")) return undefined;
  if (schema.contentEncoding === "base64" || schema.format === "byte" || schema.format === "binary") return "base64";
  if (URL_FORMATS.includes(schema.format) || (name && /(^|[_-])(url|uri)$|[a-z](Url|Uri|URL|URI)$/i.test(name))) return "url";
  return undefined;
}

const fileSchema = (sent: string) => ({
  type: "object", additionalProperties: false, required: ["$file"],
  properties: { $file: { type: "string", description: `A file in your mounts, like /workspace/report.pdf: ${sent}` } },
});
const SENT: Record<Mode | "upload", string> = { base64: "its content is sent as base64", url: "a link to it is sent, valid for 15 minutes", upload: "it is uploaded" };

/** A tool's input schema with `{"$file": path}` offered wherever a string field takes a file. `upload` describes fields sent as raw bytes. */
export function acceptFiles(schema: any, name?: string, upload = false): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const mode = fileMode(schema, name);
  if (mode) return { anyOf: [schema, fileSchema(SENT[upload && mode === "base64" ? "upload" : mode])] };
  let out = schema;
  if (schema.properties && typeof schema.properties === "object") out = { ...out, properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, acceptFiles(value, key, upload)])) };
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) out = { ...out, items: acceptFiles(schema.items, name, upload) };
  return out;
}

/** Arguments with every `{"$file": path}` replaced as the tool's schema says at that place (a link by default). */
export async function resolveFiles(value: unknown, schema: any, files: ToolFiles | undefined, name?: string): Promise<unknown> {
  if (isFileArgument(value)) {
    const available = need(files);
    return fileMode(schema, name) === "base64" ? (await available.read(value.$file)).toString("base64") : available.link(value.$file);
  }
  if (Array.isArray(value)) return Promise.all(value.map(entry => resolveFiles(entry, schema?.items, files, name)));
  if (!value || typeof value !== "object") return value;
  const entries = await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await resolveFiles(entry, schema?.properties?.[key], files, key)]));
  return Object.fromEntries(entries);
}

export function need(files: ToolFiles | undefined): ToolFiles {
  if (!files) throw new Error("This agent has no files to send: it has no volumes mounted");
  return files;
}

/** A file named in a tool's arguments, ready to send: its bytes, or a signed link to it. */
export type ToolFile = { path: string; name: string; size: number; contentType: string; stream(): AsyncIterable<Uint8Array>; link(): string };

/** Content types read as text: everything else a tool returns is saved as a file. */
export const textual = (contentType: string) => /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript|x-www-form-urlencoded)\b)|\+json\b|\+xml\b/i.test(contentType.trim());

/** A response body read whole, failing past `maxBytes`. */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(`Response larger than ${maxBytes} bytes`);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/**
 * One tool call's access to the agent's files: reading the files its arguments name (within the
 * agent's mounts, read-only ones included), and saving its outputs to the agent's workspace (the
 * writable /workspace mount, else the first writable one) within the call's and the run's budget.
 */
export class ToolFiles {
  private readonly options: { volumes: VolumeService; links?: FileLinks; tenant: string; agent: string; mounts: Mount[]; tool: string; run: { left: number }; onWrite?: ToolContext["onWrite"] };
  private left = TOOL_FILE_LIMITS.callBytes;
  private directory?: string;
  private readonly names = new Set<string>();

  /** `run` is the budget the run's calls share; each call may also save at most TOOL_FILE_LIMITS.callBytes. */
  constructor(options: ToolFiles["options"]) { this.options = options; }

  /** A file in the agent's mounts, by the path it sees. */
  async open(path: string): Promise<ToolFile> {
    const { volumes, tenant, mounts } = this.options;
    const target = resolve(mounts, path);
    if (!target) throw new Error("$file names a file, not /");
    const shown = target.show(target.path);
    const entry = await volumes.call(target.mount.volumeId, tenant, "stat", { path: target.path }).catch(error => { throw (error as { status?: number }).status === 404 ? new Error(`${shown} does not exist`) : error; });
    if (entry.type !== "file") throw new Error(`${shown} is a directory`);
    return {
      path: shown, name: shown.slice(shown.lastIndexOf("/") + 1), size: entry.size, contentType: await volumes.contentType(tenant, entry.path, entry),
      stream: () => volumes.stream(tenant, entry),
      link: () => {
        if (!this.options.links) throw new Error("This runtime cannot sign links to files");
        return this.options.links.sign({ tenant, volume: target.mount.volumeId, path: target.path, method: "GET" }).url;
      },
    };
  }

  /** A named file's bytes, for sending inline. */
  async read(path: string): Promise<Buffer> {
    const file = await this.open(path);
    if (file.size > TOOL_FILE_LIMITS.inlineBytes) throw new Error(`${file.path} is ${file.size} bytes; at most ${TOOL_FILE_LIMITS.inlineBytes} can be sent inline`);
    const parts: Uint8Array[] = [];
    for await (const chunk of file.stream()) parts.push(chunk);
    return Buffer.concat(parts);
  }

  /** A signed link to a named file, for the tool's server to fetch. */
  async link(path: string) { return (await this.open(path)).link(); }

  /** Save one of the call's outputs as `name` (sanitized), and refer to it as the transcript does. */
  async save(name: string, source: Uint8Array | AsyncIterable<Uint8Array>, contentType?: string): Promise<FileRef> {
    const { volumes, tenant, agent, mounts, run } = this.options;
    const mount = mounts.find(entry => entry.path === "/workspace" && entry.mode === "rw") ?? mounts.find(entry => entry.mode === "rw");
    if (!mount) throw new Error("this agent has no writable mount to save it to");
    const budget = Math.min(this.left, run.left);
    if (budget <= 0) throw new Error(`the tool has saved as much as it may (${TOOL_FILE_LIMITS.callBytes} bytes a call, ${TOOL_FILE_LIMITS.runBytes} a run)`);
    this.directory ??= `${mount.path}/tool-outputs/${safeName(this.options.tool, "tool")}/${randomBytes(4).toString("hex")}`;
    const base = safeName(name, "output");
    let unique = base;
    for (let n = 2; this.names.has(unique); n++) unique = base.replace(/(\.[^.]*)?$/, extension => `-${n}${extension}`);
    this.names.add(unique);
    const target = resolve(mounts, `${this.directory}/${unique}`)!;
    const saved = await volumes.put(tenant, mount.volumeId, target.path, source, { contentType, by: agent, limit: budget }).catch(error => {
      if ((error as { status?: number }).status === 413) throw new Error(`it is larger than the ${budget} bytes the tool may still save (${TOOL_FILE_LIMITS.callBytes} a call, ${TOOL_FILE_LIMITS.runBytes} a run)`);
      throw error;
    });
    this.left -= saved.size;
    run.left -= saved.size;
    const shown = target.show(saved.path);
    this.options.onWrite?.({ path: shown, version: saved.version, size: saved.size, contentType: saved.contentType! });
    return fileRef(volumes, tenant, mount.volumeId, shown, { ...saved, contentType: saved.contentType! });
  }
}

/** A name for unnamed content: its kind and number, with an extension from its type. */
const named = (kind: string, index: number, mimeType: unknown) => `${kind}-${index}${typeof mimeType === "string" && /^[a-z]+\/[a-z0-9]+/i.test(mimeType) ? `.${/^[a-z]+\/([a-z0-9]+)/i.exec(mimeType)![1].toLowerCase()}` : ""}`;
/** A resource's name from its URI's last segment. */
function resourceName(uri: unknown, index: number, mimeType: unknown) {
  try { return decodeURIComponent(new URL(String(uri)).pathname.split("/").pop() ?? "") || named("resource", index, mimeType); }
  catch { return named("resource", index, mimeType); }
}

/**
 * An MCP result with its files saved: images, audio, embedded blobs and long text resources become
 * file references. What cannot be saved stays as it was (an image) or is described in text.
 */
export async function savedContent(result: McpResult, files: ToolFiles | undefined): Promise<McpResult> {
  if (!Array.isArray(result.content)) return result;
  const content: unknown[] = [];
  let index = 0;
  for (const part of result.content) {
    // Only the runtime makes file references: a server's own would name other files' contents.
    if (part?.type === "file") { content.push({ type: "text", text: "[file content omitted]" }); continue; }
    const resource = part?.type === "resource" ? part.resource : undefined;
    let output: { name: string; bytes: Buffer; type?: string } | undefined;
    if ((part?.type === "image" || part?.type === "audio") && typeof part.data === "string") output = { name: named(part.type, ++index, part.mimeType), bytes: Buffer.from(part.data, "base64"), type: part.mimeType };
    else if (typeof resource?.blob === "string") output = { name: resourceName(resource.uri, ++index, resource.mimeType), bytes: Buffer.from(resource.blob, "base64"), type: resource.mimeType };
    else if (typeof resource?.text === "string" && Buffer.byteLength(resource.text) > TOOL_FILE_LIMITS.textBytes) output = { name: resourceName(resource.uri, ++index, resource.mimeType), bytes: Buffer.from(resource.text), type: resource.mimeType ?? "text/plain" };
    if (!output || !files) { content.push(part); continue; }
    try { content.push(await files.save(output.name, output.bytes, typeof output.type === "string" ? output.type : undefined)); }
    catch (error) { content.push(part.type === "image" || typeof resource?.text === "string" ? part : { type: "text", text: `[${part.type} content not saved: ${errorText(error)}]` }); }
  }
  return { ...result, content };
}
