import { randomBytes } from "node:crypto";
import { errorText, scratchMount } from "./protocol.ts";
import { safeName, type FileRef } from "./files.ts";
import { digestOf, type FileUrls, type FileValue } from "./file-arguments.ts";
import { fileRef } from "./inspect.ts";
import { TOOL_FILE_LIMITS } from "./limits.ts";
import type { McpResult } from "./mcp-results.ts";
import { resolve, type ToolContext } from "./volume-tools.ts";
import { TEMPORARY_SNAPSHOT, VolumeService, type FileEntry, type Mount } from "./volumes.ts";

/**
 * Files through the calls of tool sources (MCP servers, OpenAPI operations, web_fetch), without
 * their bytes passing through the model.
 *
 * In: an argument `{"$file": "/workspace/report.pdf"}` names a file in the agent's mounts. Where a
 * tool's schema has a string field for a file, the model is offered this form too (`acceptFiles`),
 * and the runtime fills it in from the schema (`resolveFiles`): base64 content for a base64 field
 * (`contentEncoding: base64`, OpenAPI's `format: byte`/`binary`), or else a URL to it bound to the call
 * (file-arguments.ts): a field marked `x-mcp-file` (MCP SEP-2631, draft), a `format: uri` field, or one
 * named like a URL. A marked field may take it inline (`data:`), and with `x-camelrun-directory` takes a
 * directory, sent as a manifest of its files. An OpenAPI multipart or binary body streams the file
 * instead (openapi.ts). The marker is explicit, so nothing is guessed from a plain string, and it reads
 * the same from a direct call and from js_exec. Only sources whose `fileArguments` is on are sent files.
 *
 * Out: images, audio, blobs and long text an MCP tool returns, and binary responses, are saved to
 * the agent's workspace under tool-outputs/<tool>/<call>/<name>; the model gets a file reference
 * (path, type, size, and the file natively when it can view it). A call and a run may save only so
 * much (TOOL_FILE_LIMITS), and what they save counts toward the volume like any file.
 */
export type FileArgument = { $file: string };
export const isFileArgument = (value: unknown): value is FileArgument =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as FileArgument).$file === "string";

type Mode = "base64" | "url" | "directory";
const URL_FORMATS = ["uri", "url", "iri", "uri-reference", "iri-reference"];

/** What a file parameter's `x-mcp-file` asks: which types (MIME, with wildcards), how large, and sent how ("url", "inline"). */
export type FileSpec = { accept?: string[]; maxSize?: number; transferModes?: string[] };
const marked = (schema: any) => !!schema["x-mcp-file"] && typeof schema["x-mcp-file"] === "object" && !Array.isArray(schema["x-mcp-file"]);
/** A marked parameter's `x-mcp-file`, its fields kept only when well-formed. */
export function fileSpec(schema: any): FileSpec {
  const spec = schema && marked(schema) ? schema["x-mcp-file"] : {};
  const strings = (value: unknown) => Array.isArray(value) && value.every(entry => typeof entry === "string") ? value as string[] : undefined;
  return {
    ...(strings(spec.accept) ? { accept: spec.accept } : {}), ...(Number.isSafeInteger(spec.maxSize) && spec.maxSize >= 0 ? { maxSize: spec.maxSize } : {}),
    ...(strings(spec.transferModes)?.length ? { transferModes: spec.transferModes } : {}),
  };
}

/** How a string field takes a file, if it does: its content as base64, a URL to it, or a URL to a directory's manifest. */
export function fileMode(schema: any, name?: string): Mode | undefined {
  if (!schema || typeof schema !== "object" || ![schema.type].flat().includes("string")) return undefined;
  if (marked(schema)) return schema["x-camelrun-directory"] === true ? "directory" : "url";
  if (schema.contentEncoding === "base64" || schema.format === "byte" || schema.format === "binary") return "base64";
  if (URL_FORMATS.includes(schema.format) || (name && /(^|[_-])(url|uri)$|[a-z](Url|Uri|URL|URI)$/i.test(name))) return "url";
  return undefined;
}

const fileSchema = (description: string) => ({
  type: "object", additionalProperties: false, required: ["$file"],
  properties: { $file: { type: "string", description } },
});
const LIFETIME = `valid for ${TOOL_FILE_LIMITS.urlSeconds / 60} minutes`;
/** What the model is told of a file field's `{"$file": path}`: what it names, what is sent, and what the tool takes. */
function described(mode: Mode, schema: any, upload: boolean) {
  if (mode === "directory") return `A directory in your files, by path, like /workspace/site: a link to a list of its files is sent, ${LIFETIME}`;
  const spec = fileSpec(schema);
  const inline = spec.transferModes?.includes("inline"), url = !spec.transferModes || spec.transferModes.includes("url");
  const sent = mode === "base64" ? (upload ? "it is uploaded" : "its content is sent as base64")
    : !url ? "its content is sent" : inline ? `its content is sent if small, else a link to it, ${LIFETIME}` : `a link to it is sent, ${LIFETIME}`;
  const takes = [spec.accept && `types ${spec.accept.join(", ")}`, spec.maxSize !== undefined && `at most ${spec.maxSize} bytes`].filter(Boolean);
  return `A file in your files, by path, like /workspace/report.pdf: ${sent}${takes.length ? ` (${takes.join("; ")})` : ""}`;
}

/** A tool's input schema with `{"$file": path}` offered wherever a string field takes a file. `upload` describes fields sent as raw bytes. */
export function acceptFiles(schema: any, name?: string, upload = false): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const mode = fileMode(schema, name);
  if (mode) return { anyOf: [schema, fileSchema(described(mode, schema, upload))] };
  let out = schema;
  if (schema.properties && typeof schema.properties === "object") out = { ...out, properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, acceptFiles(value, key, upload)])) };
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) out = { ...out, items: acceptFiles(schema.items, name, upload) };
  return out;
}

/** A JSON pointer's segment, escaped. */
const segment = (key: string | number) => String(key).replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Arguments with every `{"$file": path}` replaced as the tool's schema says at that place (a URL by default). `sent`
 * collects, by JSON pointer, each file sent as a URI, as MCP SEP-2631 describes one (its digest read only then).
 */
export async function resolveFiles(value: unknown, schema: any, files: ToolFiles | undefined, name?: string, sent?: { at: string; values: Record<string, FileValue> }): Promise<unknown> {
  if (isFileArgument(value)) {
    const available = need(files);
    const mode = fileMode(schema, name);
    if (mode === "base64") return (await available.read(value.$file)).toString("base64");
    const file = await available.send(value.$file, mode === "directory", fileSpec(schema), !!sent);
    if (sent && file.value) sent.values[sent.at] = file.value;
    return file.uri;
  }
  const at = (key: string | number) => sent && { ...sent, at: `${sent.at}/${segment(key)}` };
  if (Array.isArray(value)) return Promise.all(value.map((entry, index) => resolveFiles(entry, schema?.items, files, name, at(index))));
  if (!value || typeof value !== "object") return value;
  const entries = await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await resolveFiles(entry, schema?.properties?.[key], files, key, at(key))]));
  return Object.fromEntries(entries);
}

export function need(files: ToolFiles | undefined): ToolFiles {
  if (!files) throw new Error("This agent has no files to send: it has no volumes mounted");
  return files;
}

/** A file named in a tool's arguments, ready to send: its bytes, as they are at `entry`'s version. */
export type ToolFile = { path: string; name: string; size: number; contentType: string; volume: string; volumePath: string; entry: FileEntry; stream(): AsyncIterable<Uint8Array> };

// Whether a MIME type is one of `accept`: exact (image/png), or with wildcards (image/*, */*).
const accepts = (accept: string[], type: string) => accept.some(pattern => {
  const [kind, sub] = pattern.split(";")[0].trim().toLowerCase().split("/");
  const [own, ownSub] = type.toLowerCase().split("/");
  return (kind === "*" || kind === own) && (sub === "*" || sub === ownSub);
});

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
 * agent's mounts, read-only ones included), and saving its outputs to the agent's workspace (`scratchMount`) within
 * the call's and the run's budget. `refuse` says why its arguments may not name files (its source's fileArguments is
 * off); `urls` signs URLs bound to `call`. `release` ends the call: snapshots made for it go once its URLs expire.
 */
export class ToolFiles {
  private readonly options: { volumes: VolumeService; urls?: FileUrls; tenant: string; agent: string; mounts: Mount[]; tool: string; call?: string; refuse?: string; run: { left: number }; onWrite?: ToolContext["onWrite"] };
  private left = TOOL_FILE_LIMITS.callBytes;
  private directory?: string;
  private readonly names = new Set<string>();
  private readonly snapshots: { volume: string; id: string }[] = [];

  /** `run` is the budget the run's calls share; each call may also save at most TOOL_FILE_LIMITS.callBytes. */
  constructor(options: ToolFiles["options"]) { this.options = options; }

  /** A path in the agent's mounts, if its arguments may name files. */
  private target(path: string) {
    if (this.options.refuse) throw new Error(this.options.refuse);
    const target = resolve(this.options.mounts, path);
    if (!target) throw new Error("$file names a file, not /");
    return target;
  }

  /** A file in the agent's mounts, by the path it sees. */
  async open(path: string): Promise<ToolFile> {
    const { volumes, tenant } = this.options;
    const target = this.target(path);
    const shown = target.show(target.path);
    const entry = await volumes.call(target.mount.volumeId, tenant, "stat", { path: target.path }).catch(error => { throw (error as { status?: number }).status === 404 ? new Error(`${shown} does not exist`) : error; });
    if (entry.type !== "file") throw new Error(`${shown} is a directory`);
    return {
      path: shown, name: shown.slice(shown.lastIndexOf("/") + 1), size: entry.size, contentType: await volumes.contentType(tenant, entry.path, entry),
      volume: target.mount.volumeId, volumePath: target.path, entry,
      stream: () => volumes.stream(tenant, entry),
    };
  }

  /** A named file's bytes, for sending inline. */
  async read(path: string): Promise<Buffer> {
    const file = await this.open(path);
    if (file.size > TOOL_FILE_LIMITS.inlineBytes) throw new Error(`${file.path} is ${file.size} bytes; at most ${TOOL_FILE_LIMITS.inlineBytes} can be sent inline`);
    return this.bytes(file);
  }

  private async bytes(file: ToolFile) {
    const parts: Uint8Array[] = [];
    for await (const chunk of file.stream()) parts.push(chunk);
    return Buffer.concat(parts);
  }

  private signed(grant: { volume: string; path: string; agentPath: string; kind: "file" | "manifest"; version?: number; snapshot?: string }, name: string) {
    const { urls, tenant, agent, tool, call } = this.options;
    if (!urls || !call) throw new Error("This runtime cannot sign links to files");
    return urls.url({ tenant, agent, call, tool, ...grant }, name, Date.now() + TOOL_FILE_LIMITS.urlSeconds * 1000);
  }

  /**
   * A named file (or `directory`) as a URI for the tool: inline as `data:` where `spec` allows and it is small enough,
   * else a URL bound to this call and the file's version (a directory's: to a manifest of a snapshot made for the call).
   * With `describe`, also the file as SEP-2631 describes it, digest included.
   */
  async send(path: string, directory: boolean, spec: FileSpec, describe: boolean): Promise<{ uri: string; value?: FileValue }> {
    const { volumes, tenant } = this.options;
    if (directory) {
      const target = this.target(path);
      const shown = target.show(target.path);
      const entry = await volumes.call(target.mount.volumeId, tenant, "stat", { path: target.path }).catch(error => { throw (error as { status?: number }).status === 404 ? new Error(`${shown} does not exist`) : error; });
      if (entry.type !== "directory") throw new Error(`${shown} is a file; this argument takes a directory`);
      const snapshot = await volumes.call(target.mount.volumeId, tenant, "snapshot", {
        name: `${TEMPORARY_SNAPSHOT}${this.options.call ?? ""}`.slice(0, 120), directory: target.path,
        limit: { files: TOOL_FILE_LIMITS.directoryFiles, bytes: TOOL_FILE_LIMITS.directoryBytes },
      }).catch(error => { throw (error as { status?: number }).status === 413 ? new Error(`${errorText(error).replace(target.path, shown)}: a directory sent to a tool has at most ${TOOL_FILE_LIMITS.directoryFiles} files and ${TOOL_FILE_LIMITS.directoryBytes} bytes`) : error; });
      this.snapshots.push({ volume: target.mount.volumeId, id: snapshot.id });
      return { uri: await this.signed({ volume: target.mount.volumeId, path: target.path, agentPath: shown, kind: "manifest", snapshot: snapshot.id }, `${shown.slice(shown.lastIndexOf("/") + 1)}.json`) };
    }
    const file = await this.open(path);
    if (spec.accept && !accepts(spec.accept, file.contentType)) throw new Error(`${file.path} is ${file.contentType}; this argument takes ${spec.accept.join(", ")}`);
    if (spec.maxSize !== undefined && file.size > spec.maxSize) throw new Error(`${file.path} is ${file.size} bytes; this argument takes at most ${spec.maxSize}`);
    const inline = spec.transferModes?.includes("inline"), url = !spec.transferModes || spec.transferModes.includes("url");
    let uri: string;
    if (inline && file.size <= TOOL_FILE_LIMITS.inlineBytes) uri = `data:${file.contentType};base64,${(await this.bytes(file)).toString("base64")}`;
    else if (url) uri = await this.signed({ volume: file.volume, path: file.volumePath, agentPath: file.path, kind: "file", version: file.entry.version }, file.name);
    else throw new Error(`${file.path} is ${file.size} bytes; this argument takes files inline only, at most ${TOOL_FILE_LIMITS.inlineBytes}`);
    if (!describe) return { uri };
    const digest = await digestOf(volumes, tenant, file.entry);
    return { uri, value: { uri, name: file.name, mimeType: file.contentType, size: file.size, ...(digest ? { digest: { algorithm: "sha-256", value: digest } } : {}) } };
  }

  /** The call has ended: the snapshots made for it are deleted once the URLs naming them have expired. */
  release() {
    const { volumes, tenant } = this.options;
    for (const snapshot of this.snapshots.splice(0)) {
      const timer = setTimeout(() => void volumes.call(snapshot.volume, tenant, "deleteSnapshot", { snapshot: snapshot.id }).catch(() => {}), TOOL_FILE_LIMITS.urlSeconds * 1000);
      timer.unref();
    }
  }

  /** Save one of the call's outputs as `name` (sanitized), and refer to it as the transcript does. */
  async save(name: string, source: Uint8Array | AsyncIterable<Uint8Array>, contentType?: string): Promise<FileRef> {
    const { volumes, tenant, agent, mounts, run } = this.options;
    const mount = scratchMount(VolumeService.markWorkspace(agent, mounts));
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
    return fileRef(volumes, tenant, this.options.agent, mount.volumeId, shown, { ...saved, contentType: saved.contentType! });
  }
}

/** A name for unnamed content: its kind and number, with an extension from its type. */
const named = (kind: string, index: number, mimeType: unknown) => `${kind}-${index}${typeof mimeType === "string" && /^[a-z]+\/[a-z0-9]+/i.test(mimeType) ? `.${/^[a-z]+\/([a-z0-9]+)/i.exec(mimeType)![1].toLowerCase()}` : ""}`;
/** A resource's name from its URI's last segment. */
function resourceName(uri: unknown, index: number, mimeType: unknown) {
  try { return decodeURIComponent(new URL(String(uri)).pathname.split("/").pop() ?? "") || named("resource", index, mimeType); }
  catch { return named("resource", index, mimeType); }
}

/** A `data:` URI's bytes and type, or undefined if it is not one. */
function dataUri(uri: string): { bytes: Buffer; type?: string } | undefined {
  const match = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/is.exec(uri);
  if (!match) return undefined;
  const base64 = match[2].split(";").includes("base64");
  return { bytes: base64 ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3])), ...(match[1] ? { type: match[1].toLowerCase() } : {}) };
}

/**
 * A `resource_link` saved as a file: a `data:` URI's bytes, or what an http(s) URI answers (`fetch` goes through the
 * outbound guard and caps the body at TOOL_FILE_LIMITS.responseBytes).
 */
async function savedLink(part: { uri: string; name?: unknown; mimeType?: unknown }, index: number, files: ToolFiles, fetch: (url: string) => Promise<Response>): Promise<FileRef> {
  const given = typeof part.mimeType === "string" ? part.mimeType : undefined;
  const inline = dataUri(part.uri);
  if (inline) {
    if (inline.bytes.length > TOOL_FILE_LIMITS.responseBytes) throw new Error(`it is larger than ${TOOL_FILE_LIMITS.responseBytes} bytes`);
    return files.save(typeof part.name === "string" ? part.name : named("resource", index, given ?? inline.type), inline.bytes, given ?? inline.type);
  }
  const response = await fetch(part.uri);
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error(`fetching it answered HTTP ${response.status}`); }
  const type = given ?? response.headers.get("content-type") ?? undefined;
  return files.save(typeof part.name === "string" ? part.name : resourceName(part.uri, index, type), response.body as unknown as AsyncIterable<Uint8Array>, type);
}

/**
 * An MCP result with its files saved: images, audio, embedded blobs and long text resources become
 * file references. What cannot be saved stays as it was (an image) or is described in text. With
 * `fetch` (a source whose fileArguments is on), `resource_link`s to http(s) and `data:` URIs are saved
 * too, and the transcript keeps their paths, never their URLs.
 */
export async function savedContent(result: McpResult, files: ToolFiles | undefined, fetch?: (url: string) => Promise<Response>): Promise<McpResult> {
  if (!Array.isArray(result.content)) return result;
  const content: unknown[] = [];
  let index = 0;
  for (const part of result.content) {
    // Only the runtime makes file references: a server's own would name other files' contents.
    if (part?.type === "file") { content.push({ type: "text", text: "[file content omitted]" }); continue; }
    if (fetch && part?.type === "resource_link" && typeof part.uri === "string" && /^(https?|data):/i.test(part.uri)) {
      const label = typeof part.name === "string" ? part.name : "linked file";
      try { content.push(await savedLink(part, ++index, need(files), fetch)); }
      catch (error) { content.push({ type: "text", text: `[${label} not saved: ${errorText(error)}]` }); }
      continue;
    }
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
