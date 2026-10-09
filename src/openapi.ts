import { randomBytes } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { ToolDefinition } from "./protocol.ts";
import type { McpResult } from "./mcp-results.ts";
import { jsonResult } from "./tool-servers.ts";
import { acceptFiles, fileMode, isFileArgument, need, readCapped, resolveFiles, type ToolFile, type ToolFiles } from "./tool-files.ts";
import { textual } from "./files.ts";

/**
 * OpenAPI 3 specs as a tool source, as Executor's openapi plugin does it: every operation is
 * a tool whose input is its parameters by name plus `body` (the request body), and a call
 * sends the request the spec describes. A 2xx answer's body is the result, saved as a file when it
 * is not text or JSON; any other status is a tool error quoting it. A multipart or binary body
 * takes files as `{"$file": path}` and streams them (see tool-files.ts).
 */
export type Parameter = { name: string; in: "path" | "query" | "header"; required?: boolean };
/**
 * `body` is how the request body is sent: as JSON, form-encoded (nested values in brackets), as
 * multipart form data, or as the bytes themselves (`bodyType` says which type the spec takes).
 */
export type Operation = { name: string; description: string; method: string; path: string; parameters: Parameter[]; body?: "json" | "form" | "multipart" | "binary"; bodyType?: string; inputSchema: Record<string, unknown>; readOnly: boolean };
export type Api = { baseUrl?: string; operations: Operation[] };

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const READ_ONLY = new Set(["get", "head", "options"]);
const MAX_DESCRIPTION = 4_000;
const RESULT_BYTES = 1024 * 1024;

/** A spec's text (JSON or YAML) as a document; OpenAPI 3 only. */
export function parseSpec(text: string): Record<string, unknown> {
  let doc: unknown;
  try { doc = text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 }); }
  catch (error) { throw new Error(`The spec is not valid JSON or YAML: ${(error as Error).message.slice(0, 200)}`); }
  return checkDocument(doc);
}

export function checkDocument(doc: unknown): Record<string, unknown> {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("The spec must be an OpenAPI document");
  const version = (doc as { openapi?: unknown }).openapi;
  if (typeof version !== "string" || !version.startsWith("3.")) throw new Error("Only OpenAPI 3 specs are supported (Swagger 2 can be converted with swagger2openapi)");
  return doc as Record<string, unknown>;
}

/** How far references are inlined in one operation's input: nesting, and nodes in all. */
const REF_DEPTH = 6;
const NODE_BUDGET = 4_000;
type Budget = { nodes: number };

/**
 * `value` with local `$ref`s replaced by what they point to. Specs cross-reference heavily
 * (inlining all of Stripe's would not fit in memory), so a reference back into itself, one
 * nested past REF_DEPTH, or any once the operation's node budget is spent becomes `{}`: any
 * value, which the API itself still checks.
 */
function deref(doc: Record<string, unknown>, value: unknown, budget: Budget = { nodes: 0 }, seen: string[] = []): any {
  if (Array.isArray(value)) return value.map(entry => deref(doc, entry, budget, seen));
  if (!value || typeof value !== "object") return value;
  if (++budget.nodes > NODE_BUDGET) return {};
  const ref = (value as { $ref?: unknown }).$ref;
  if (typeof ref === "string") {
    if (!ref.startsWith("#/") || seen.includes(ref) || seen.length >= REF_DEPTH) return {};
    return deref(doc, lookup(doc, ref) ?? {}, budget, [...seen, ref]);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = deref(doc, entry, budget, seen);
  // OpenAPI 3.0's `nullable` in JSON Schema's words.
  if (out.nullable === true && typeof out.type === "string") { out.type = [out.type, "null"]; delete out.nullable; }
  return out;
}

/** What a local reference (`#/components/…`) points to. */
const lookup = (doc: Record<string, unknown>, ref: string) => ref.slice(2).split("/").reduce<any>((node, key) => node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], doc);

const isJson = (mediaType: string) => /^application\/(.+\+)?json\b/i.test(mediaType.split(";")[0].trim());
const isForm = (mediaType: string) => mediaType.split(";")[0].trim().toLowerCase() === "application/x-www-form-urlencoded";
const isMultipart = (mediaType: string) => mediaType.split(";")[0].trim().toLowerCase() === "multipart/form-data";
/** A tool name from an operation id (or method and path): letters, digits and single underscores. */
const toolName = (value: string) => value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(?=[0-9])/, "op_") || "operation";

/** The spec's operations as tool bindings. A body of any other type (a file's, like application/octet-stream) is sent as bytes. */
export function operations(doc: Record<string, unknown>, specUrl?: string): Api {
  const found: Operation[] = [];
  for (const [path, rawItem] of Object.entries((doc.paths ?? {}) as Record<string, any>)) {
    const item = (typeof rawItem?.$ref === "string" && rawItem.$ref.startsWith("#/") ? lookup(doc, rawItem.$ref) : rawItem) ?? {};
    for (const method of METHODS) {
      const raw = item[method];
      if (!raw || typeof raw !== "object") continue;
      // Only what becomes the tool's input is resolved: parameters and the request body, never responses.
      const budget: Budget = { nodes: 0 };
      const operation = { ...raw, parameters: deref(doc, raw.parameters ?? [], budget), requestBody: deref(doc, raw.requestBody, budget) };
      const shared = deref(doc, item.parameters ?? [], budget);
      // Operation parameters override the path item's of the same name and place; cookies are not sent.
      const byKey = new Map<string, any>();
      for (const parameter of [...shared, ...operation.parameters]) if (parameter?.name && ["path", "query", "header"].includes(parameter.in)) byKey.set(`${parameter.in}:${parameter.name}`, parameter);
      const parameters = [...byKey.values()];
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const parameter of parameters) {
        const schema = { ...parameter.schema ?? { type: "string" } };
        if (parameter.description && !schema.description) schema.description = String(parameter.description).slice(0, 1_000);
        properties[parameter.name] = schema;
        if (parameter.required || parameter.in === "path") required.push(parameter.name);
      }
      // Reads send no body, whatever the spec declares (Stripe's GETs declare an empty form).
      const content = READ_ONLY.has(method) ? undefined : operation.requestBody?.content as Record<string, any> | undefined;
      const entries = Object.entries(content ?? {});
      const json = entries.find(([type]) => isJson(type)), form = entries.find(([type]) => isForm(type)), multipart = entries.find(([type]) => isMultipart(type));
      const chosen = json ?? form ?? multipart ?? entries[0];
      const body = !chosen ? undefined : json ? "json" as const : form ? "form" as const : multipart ? "multipart" as const : "binary" as const;
      if (chosen) {
        properties.body = body === "binary" ? { type: "string", format: "binary", description: `The request body (${chosen[0]})` } : chosen[1]?.schema ?? { type: "object" };
        if (operation.requestBody.required) required.push("body");
      }
      const text = [operation.summary, operation.description].filter(entry => typeof entry === "string" && entry.trim()).join("\n\n");
      found.push({
        name: toolName(operation.operationId ?? `${method}_${path}`), method: method.toUpperCase(), path,
        description: (text || `${method.toUpperCase()} ${path}`).slice(0, MAX_DESCRIPTION),
        parameters: parameters.map(({ name, in: place, required: needed }) => ({ name, in: place, ...(needed || place === "path" ? { required: true } : {}) })),
        ...(body ? { body } : {}), ...(body === "binary" ? { bodyType: chosen![0].split(";")[0].trim().toLowerCase() } : {}),
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
        readOnly: READ_ONLY.has(method),
      });
    }
  }
  return { ...(serverUrl(doc, specUrl) ? { baseUrl: serverUrl(doc, specUrl) } : {}), operations: found };
}

/** The spec's first server, with its variables at their defaults, resolved against the spec's own URL. */
function serverUrl(doc: Record<string, unknown>, specUrl?: string): string | undefined {
  const server = (doc.servers as any[] | undefined)?.[0];
  if (!server?.url || typeof server.url !== "string") return specUrl ? new URL(specUrl).origin : undefined;
  const url = server.url.replace(/\{([^}]+)\}/g, (_: string, name: string) => String(server.variables?.[name]?.default ?? ""));
  try { return new URL(url, specUrl).toString(); } catch { return undefined; }
}

/** An operation as the agent sees it: `<source>__<operation>`, reads in parallel, file fields taking `{"$file": path}` when its source `takesFiles`. */
export function definition(source: string, operation: Operation, takesFiles = true): ToolDefinition {
  const parameters = takesFiles ? acceptFiles(operation.inputSchema) : operation.inputSchema;
  const properties = operation.inputSchema.properties as Record<string, unknown> | undefined;
  if (takesFiles && raw(operation) && properties?.body) parameters.properties.body = acceptFiles(properties.body, "body", true);
  return {
    name: `${source}__${operation.name}`.slice(0, 80), description: operation.description, parameters,
    ...(operation.readOnly ? { executionMode: "parallel" as const } : {}),
  };
}

const raw = (operation: Operation) => operation.body === "multipart" || operation.body === "binary";

/** The request an operation's call makes: its URL (path and query filled in), headers and body, files filled in or streamed. */
export async function request(baseUrl: string, operation: Operation, input: Record<string, unknown>, files?: ToolFiles) {
  const { body: rawBody, ...rest } = input;
  const args = await resolveFiles(raw(operation) ? rest : input, operation.inputSchema, files) as Record<string, unknown>;
  const value = (name: string) => args[name];
  const text = (entry: unknown) => typeof entry === "string" ? entry : JSON.stringify(entry);
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    if (value(name) === undefined) throw new Error(`Missing path parameter ${name}`);
    return encodeURIComponent(text(value(name)));
  });
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  const headers: Record<string, string> = { Accept: "application/json, text/plain;q=0.9, */*;q=0.5", "User-Agent": "agent-runtime" };
  for (const parameter of operation.parameters) {
    const entry = value(parameter.name);
    if (entry === undefined || entry === null) continue;
    if (parameter.in === "query") for (const item of Array.isArray(entry) ? entry : [entry]) url.searchParams.append(parameter.name, text(item));
    else if (parameter.in === "header") headers[parameter.name] = text(entry);
  }
  if (!operation.body || rawBody === undefined) return { url, init: { method: operation.method, headers } };
  if (operation.body === "json" || operation.body === "form") {
    headers["Content-Type"] = operation.body === "form" ? "application/x-www-form-urlencoded" : "application/json";
    return { url, init: { method: operation.method, headers, body: operation.body === "form" ? formEncode(args.body) : JSON.stringify(args.body) } };
  }
  const bodySchema = (operation.inputSchema.properties as Record<string, any> | undefined)?.body;
  const sent = operation.body === "multipart" ? await multipart(rawBody, bodySchema, files) : await bytes(rawBody, operation.bodyType!, files);
  headers["Content-Type"] = sent.type;
  headers["Content-Length"] = String(sent.length);
  // Streamed: undici takes an async iterable body when told the request is half duplex.
  return { url, init: { method: operation.method, headers, body: sent.body as unknown as BodyInit, duplex: "half" } as RequestInit };
}

type Body = { body: AsyncIterable<Uint8Array>; length: number; type: string };
const concat = (parts: (Uint8Array | ToolFile)[], type: string): Body => ({
  type, length: parts.reduce((sum, part) => sum + (part instanceof Uint8Array ? part.length : part.size), 0),
  body: (async function* () { for (const part of parts) if (part instanceof Uint8Array) yield part; else yield* part.stream(); })(),
});

/** A binary body: a named file streamed, or a string as it is. A body taking any type of a kind (image/*) is sent as the file's own type. */
async function bytes(value: unknown, bodyType: string, files: ToolFiles | undefined): Promise<Body> {
  if (!isFileArgument(value)) return concat([Buffer.from(typeof value === "string" ? value : JSON.stringify(value))], bodyType.includes("*") ? "application/octet-stream" : bodyType);
  const file = await need(files).open(value.$file);
  return concat([file], bodyType.includes("*") ? file.contentType : bodyType);
}

/** A multipart form: each field a part, a named file streamed as a file part (a field taking a link gets its link). */
async function multipart(value: unknown, schema: any, files: ToolFiles | undefined): Promise<Body> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body must be an object of form fields");
  const boundary = `agent-runtime-${randomBytes(12).toString("hex")}`;
  const quoted = (text: string) => text.replace(/["\r\n\\]/g, char => encodeURIComponent(char));
  const parts: (Uint8Array | ToolFile)[] = [];
  const add = async (name: string, entry: unknown, fieldSchema: any): Promise<void> => {
    if (entry === undefined || entry === null) return;
    if (Array.isArray(entry)) { for (const item of entry) await add(name, item, fieldSchema?.items); return; }
    if (isFileArgument(entry) && fileMode(fieldSchema, name) !== "url") {
      const file = await need(files).open(entry.$file);
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"; filename="${quoted(file.name)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`), file, Buffer.from("\r\n"));
      return;
    }
    const resolved = await resolveFiles(entry, fieldSchema, files, name);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${typeof resolved === "string" ? resolved : JSON.stringify(resolved)}\r\n`));
  };
  for (const [name, entry] of Object.entries(value)) await add(name, entry, schema?.properties?.[name]);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return concat(parts, `multipart/form-data; boundary=${boundary}`);
}

/** A value form-encoded, nested values in brackets (`metadata[key]=v`, `expand[]=x`), as Stripe and Rails read them. */
export function formEncode(value: unknown): string {
  const form = new URLSearchParams();
  const add = (key: string, entry: unknown) => {
    if (entry === undefined || entry === null) return;
    if (Array.isArray(entry)) entry.forEach(item => add(`${key}[]`, item));
    else if (typeof entry === "object") for (const [name, inner] of Object.entries(entry)) add(key ? `${key}[${name}]` : name, inner);
    else form.append(key, String(entry));
  };
  add("", value);
  return form.toString();
}

/**
 * A response as an MCP result: a 2xx body is the data (parsed when it is JSON), or a file saved to
 * the workspace when it is neither text nor JSON; anything else is an error quoting it.
 */
export async function result(operation: Operation, response: Response, files?: ToolFiles): Promise<McpResult> {
  const type = response.headers.get("content-type") ?? "";
  if (response.ok && type && !textual(type) && response.body) {
    const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers.get("content-disposition") ?? "")?.[1];
    let name = operation.name;
    try { if (disposition) name = decodeURIComponent(disposition); } catch { /* the name as the operation's */ }
    try { return { content: [await need(files).save(name, response.body as unknown as AsyncIterable<Uint8Array>, type)] }; }
    catch (error) {
      await response.body.cancel().catch(() => {});
      throw new Error(`${operation.method} ${operation.path} answered with ${type.split(";")[0]}, which was not saved: ${(error as Error).message}`);
    }
  }
  const text = (await readCapped(response, RESULT_BYTES)).toString("utf8");
  if (!response.ok) return { content: [{ type: "text", text: `${operation.method} ${operation.path} answered HTTP ${response.status}${text ? `: ${text.slice(0, 2_000)}` : ""}` }], isError: true };
  if (!text) return jsonResult(null);
  if (/[/+]json\b/i.test(response.headers.get("content-type") ?? "")) {
    try { return jsonResult(JSON.parse(text)); } catch { /* not JSON after all: the text */ }
  }
  return { content: [{ type: "text", text }] };
}

export { RESULT_BYTES };
