import { TOOL_FILE_LIMITS } from './limits.ts';

/** Portable file schemas and argument traversal. Hosts supply only reading and sending. */
export type FileArguments = 'on' | 'off';
export const takesFiles = (source: { auth?: { type: string }; fileArguments?: FileArguments }) =>
  (source.fileArguments ?? (source.auth?.type === 'runtime' ? 'on' : 'off')) === 'on';
export type FileValue = { uri: string; name: string; mimeType: string; size: number; digest?: { algorithm: 'sha-256'; value: string } };
export interface FileAccess {
  read(path: string): Promise<Uint8Array>;
  send(path: string, directory: boolean, spec: FileSpec, describe: boolean): Promise<{ uri: string; value?: FileValue }>;
}

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
export async function resolveFiles(value: unknown, schema: any, files: FileAccess | undefined, name?: string, sent?: { at: string; values: Record<string, FileValue> }): Promise<unknown> {
  if (isFileArgument(value)) {
    const available = need(files);
    const mode = fileMode(schema, name);
    if (mode === "base64") return base64(await available.read(value.$file));
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

/** Standard base64 of bytes, as Buffer's toString("base64") writes it. */
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export function need<T extends FileAccess>(files: T | undefined): T {
  if (!files) throw new Error("This agent has no files to send: it has no volumes mounted");
  return files;
}

