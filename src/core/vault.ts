import { parse } from "tldts";
import type { Sql } from "./host.ts";
import { HttpError } from "./http-error.ts";
import type { Sealed } from "./github-apps.ts";

export type VaultAuth = { type: "vault"; name: string; workspace?: string; inBody?: boolean };
export type SecretPolicy = { allowedHosts: string[]; locations: ("header" | "query" | "body")[] };
export type SecretInput = { value?: string; allowedHosts?: string[]; locations?: SecretPolicy["locations"] };
export type Networking = { type: "unrestricted" | "limited"; allowedHosts: string[]; allowPackageManagers: boolean; allowMcpServers: boolean };
const bad = (text: string) => new HttpError(400, text);
export function secretName(value: unknown, reserved: string[] = []): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) throw bad("Secret names use 1–64 uppercase letters, digits and underscores");
  if (/^(?:PATH|HOME|SSL_CERT_FILE|NODE_OPTIONS)$/.test(value) || value.startsWith("LD_") || reserved.includes(value) || ["NODE_EXTRA_CA_CERTS", "GIT_TERMINAL_PROMPT", "REQUESTS_CA_BUNDLE", "PIP_CERT"].includes(value)) throw bad("Secret name is reserved by the runtime");
  return value;
}
export function hostRules(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) throw bad("allowedHosts must contain at most 64 public DNS names");
  return [...new Set(value.map(v => {
    if (typeof v !== "string") throw bad("Invalid allowed host");
    const rule = v.toLowerCase().replace(/\.$/, ""), host = rule.startsWith("*.") ? rule.slice(2) : rule;
    const result = parse(host, { allowPrivateDomains: true });
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host) || host.length > 253 || !result.domain || !result.isIcann && !result.isPrivate || /(^|\.)(localhost|local|internal|localdomain|home|lan|test|invalid|example)$/.test(host))
      throw bad("Use a public hostname, not a public suffix or private address");
    return rule;
  }))];
}
export const hostMatches = (host: string, rule: string) => rule.startsWith("*.") ? host.endsWith(rule.slice(1)) && host !== rule.slice(2) : host === rule;
export function vaultAuth(value: unknown): VaultAuth {
  const v = value as VaultAuth;
  if (!v || v.type !== "vault" || Object.keys(v).some(k => !["type", "name", "workspace", "inBody"].includes(k)) || v.workspace !== undefined && (typeof v.workspace !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v.workspace))) throw bad("Vault auth is {type: vault, name, workspace?, inBody?}");
  if (v.inBody !== undefined && typeof v.inBody !== "boolean") throw bad("inBody must be boolean");
  return { type: "vault", ...(v.inBody ? { inBody: true } : {}), name: secretName(v.name), ...(v.workspace ? { workspace: v.workspace } : {}) };
}
export function networkingInput(value: unknown): Networking {
  const v = value as Networking;
  if (!v || !["unrestricted", "limited"].includes(v.type) || Object.keys(v).some(k => !["type", "allowedHosts", "allowPackageManagers", "allowMcpServers"].includes(k))) throw bad("Invalid networking policy");
  for (const key of ["allowPackageManagers", "allowMcpServers"] as const) if (v[key] !== undefined && typeof v[key] !== "boolean") throw bad(`${key} must be boolean`);
  return { type: v.type, allowedHosts: hostRules(v.allowedHosts ?? []), allowPackageManagers: v.allowPackageManagers ?? false, allowMcpServers: v.allowMcpServers ?? false };
}
export const secretPlaceholder = (name: string) => `camel-vault-${secretName(name)}-placeholder`;
type Keys = { reservedNames?: string[]; canStore: boolean; seal(context: string, text: string): Sealed; unseal(context: string, sealed: Sealed): string };
/** No decrypted values or policy decisions are cached. Scope and tenant are authenticated storage keys. */
export class Vault {
  readonly sql: Sql;
  readonly keys: Keys;
  constructor(sql: Sql, keys: Keys) { this.sql = sql; this.keys = keys; }
  private scope(workspace = "") {
    if (workspace && !/^[a-zA-Z0-9_-]{1,100}$/.test(workspace)) throw bad("Invalid workspace");
    return workspace;
  }
  private aad(tenant: string, workspace: string, name: string) { return JSON.stringify(["vault", tenant, workspace, name]); }
  async list(tenant: string, workspace = ""): Promise<string[]> {
    return (await this.sql.query("select name from vault_secrets where tenant=$1 and workspace=$2 order by name", [tenant, this.scope(workspace)])).rows.map(r => r.name);
  }
  async put(tenant: string, name: string, input: SecretInput, workspace = "", create = false) {
    secretName(name, this.keys.reservedNames); this.scope(workspace);
    if (!input || typeof input !== "object" || Object.keys(input).some(k => !["value", "allowedHosts", "locations"].includes(k))) throw bad("Secret is {value, allowedHosts, locations?}");
    if (!this.keys.canStore) throw new HttpError(503, "This runtime has no secrets key");
    const old = (await this.sql.query("select policy, sealed from vault_secrets where tenant=$1 and workspace=$2 and name=$3", [tenant, workspace, name])).rows[0];
    if (create && old) throw new HttpError(409, "Secret already exists");
    if (!create && !old) throw new HttpError(404, "Secret not found");
    if (!old && input.value === undefined) throw bad("Secret value is required");
    if (input.value !== undefined && (typeof input.value !== "string" || input.value.length < 8 || input.value.length > 8192 || /[\r\n\0]/.test(input.value))) throw bad("Secret value must be 8–8192 single-line characters");
    const policy: SecretPolicy = { allowedHosts: hostRules(input.allowedHosts ?? old?.policy.allowedHosts ?? []), locations: input.locations ?? old?.policy.locations ?? ["header"] };
    if (!Array.isArray(policy.locations) || !policy.locations.length || policy.locations.some(v => !["header", "query", "body"].includes(v))) throw bad("Secret locations are header, query or body");
    const sealed = input.value === undefined ? old.sealed : this.keys.seal(this.aad(tenant, workspace, name), input.value);
    if (create) await this.sql.query("insert into vault_secrets (tenant,workspace,name,policy,sealed) values ($1,$2,$3,$4,$5)", [tenant,workspace,name,JSON.stringify(policy),JSON.stringify(sealed)]);
    else await this.sql.query("update vault_secrets set policy=$4,sealed=$5 where tenant=$1 and workspace=$2 and name=$3", [tenant,workspace,name,JSON.stringify(policy),JSON.stringify(sealed)]);
    return { name };
  }
  async remove(tenant: string, name: string, workspace = "") {
    const result = await this.sql.query("delete from vault_secrets where tenant=$1 and workspace=$2 and name=$3", [tenant,this.scope(workspace),secretName(name)]);
    if (!result.rowCount) throw new HttpError(404, "Secret not found");
  }
  async open(tenant: string, ref: VaultAuth, url: URL, location: SecretPolicy["locations"][number]) {
    const workspace = this.scope(ref.workspace), name = secretName(ref.name, this.keys.reservedNames);
    const row = (await this.sql.query("select policy,sealed from vault_secrets where tenant=$1 and workspace=$2 and name=$3", [tenant,workspace,name])).rows[0];
    if (!row) throw new HttpError(404, "Secret not found");
    const policy = row.policy as SecretPolicy;
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || !policy.allowedHosts.some(rule => hostMatches(url.hostname, rule)) || !policy.locations.includes(location)) throw new HttpError(403, "Secret is not allowed at this destination or location");
    return this.keys.unseal(this.aad(tenant,workspace,name), row.sealed);
  }
}

/** The gateway is the only caller. Redact bytes as well as text, including encoded echoes. */
export async function maskResponse(response: Response, values: string[]): Promise<Response> {
  values = values.filter(value => value.length >= 8);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^(?:text\/|application\/(?:[a-z0-9.-]+\+)?(?:json|xml)(?:;|$)|application\/x-www-form-urlencoded(?:;|$))/i.test(contentType)) return response;
  if (!values.length) return response;
  const encoder = new TextEncoder();
  const base64 = (v: string) => btoa(Array.from(encoder.encode(v), c => String.fromCharCode(c)).join(""));
  const forms = [...new Set(values.flatMap(v => [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), base64(v), base64(`x-access-token:${v}`)]))].sort((a,b) => b.length-a.length);
  const needles = forms.map(v => encoder.encode(v));
  const replacement = encoder.encode("[hidden]");
  let pending = new Uint8Array(0);
  let changed = false;
  const filter = (chunk: Uint8Array, final: boolean) => {
    const input = new Uint8Array(pending.length + chunk.length); input.set(pending); input.set(chunk,pending.length);
    const output: number[] = []; let i=0;
    while (i < input.length) {
      if (!final && needles.some(n => n.length > input.length-i && input.subarray(i).every((v,j) => n[j] === v))) break;
      const match = needles.find(n => n.every((v,j) => input[i+j] === v));
      if (match) { changed = true; output.push(...replacement); i+=match.length; }
      else output.push(input[i++]!);
    }
    pending = input.slice(i); return new Uint8Array(output);
  };
  const hide = (s: string) => forms.reduce((s,v) => s.split(v).join("[hidden]"), s);
  const headers = new Headers(); response.headers.forEach((v,k) => headers.set(k, hide(v)));
  const headerChanged = [...response.headers].some(([k,v]) => headers.get(k) !== v) || hide(response.statusText) !== response.statusText;
  // Validators and fixed lengths can only be preserved after knowing whether text changed.
  if (response.headers.has("content-length") || response.headers.has("etag")) {
    const bodyless = response.body === null;
    const original = new Uint8Array(await response.arrayBuffer());
    const filtered = filter(original, true);
    if (!changed && !headerChanged) return new Response(bodyless ? null : original, {status:response.status,statusText:response.statusText,headers:response.headers});
    for (const key of ["content-length", "content-encoding", "etag", "content-md5"]) headers.delete(key);
    return new Response(bodyless ? null : filtered, {status:response.status,statusText:hide(response.statusText),headers});
  }
  const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { controller.enqueue(filter(chunk, false)); },
    flush(controller) { controller.enqueue(filter(new Uint8Array(0), true)); },
  }));
  if (headerChanged) for (const key of ["content-length", "etag", "content-md5"]) headers.delete(key);
  headers.delete("content-encoding");
  return new Response(stream ?? null, { status: response.status, statusText: hide(response.statusText), headers });
}

/** Substitute only attached placeholders and only in the configured locations. */
export async function vaultRequest(request: Request, refs: VaultAuth[], vault: Vault | (() => Promise<Vault>), tenant: string) {
  decodeVaultPath(new URL(request.url).pathname); decodeVaultPath(new URL(request.url).search);
  if (!refs.some(ref => ref.inBody) && !request.url.includes("camel-vault-") && ![...request.headers.values()].some(v => v.includes("camel-vault-"))) return { request, values: [] as string[] };
  const url = new URL(request.url), headers = new Headers(request.headers);
  let rawBody: Uint8Array | undefined;
  if (request.body && refs.some(ref => ref.inBody)) {
    const parts: Uint8Array[] = []; let size = 0;
    for await (const part of request.body as unknown as AsyncIterable<Uint8Array>) {
      size += part.length;
      if (size > 8 * 1024 * 1024) throw new HttpError(413, "Vault request body exceeds 8 MiB");
      parts.push(part);
    }
    rawBody = new Uint8Array(size); let offset = 0;
    for (const part of parts) { rawBody.set(part, offset); offset += part.length; }
  }
  let query = url.search, body = rawBody ? new TextDecoder().decode(rawBody) : undefined;
  const replaceBody = body?.includes("camel-vault-") ?? false;
  const values: string[] = [];
  if (url.pathname.includes("camel-vault-") || url.host.includes("camel-vault-")) throw new HttpError(403, "Secrets cannot be used in the host or path");
  for (const ref of refs) {
    const placeholder = secretPlaceholder(ref.name);
    const fill = async (text: string, location: SecretPolicy["locations"][number]) => {
      if (!text.includes(placeholder)) return text;
      const service = typeof vault === "function" ? await vault() : vault;
      const value = await service.open(tenant,ref,url,location); values.push(value);
      return text.split(placeholder).join(location === "query" ? encodeURIComponent(value) : value);
    };
    query = await fill(query, "query");
    if (body !== undefined && ref.inBody) body = await fill(body,"body");
    for (const [key,value] of headers) headers.set(key,await fill(value,"header"));
  }
  if (replaceBody) headers.delete("content-length");
  url.search = query;
  if (url.origin !== new URL(request.url).origin) throw new HttpError(403,"Secret substitution changed the destination");
  if ([url.href,body ?? "",...headers.values()].some(v => v.includes("camel-vault-"))) throw new HttpError(403,"Unattached secret placeholder");
  return { request: new Request(url, { method: request.method, headers, ...(request.body ? { body: body === undefined ? request.body : replaceBody ? body : rawBody as BodyInit } : {}), redirect: "manual", duplex: "half" } as RequestInit), values };
}

export const PACKAGE_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io"];
export function networkAllows(policy: Networking, url: URL, mcpHosts: string[] = []) {
  return policy.type === "unrestricted" || [...policy.allowedHosts, ...(policy.allowPackageManagers ? PACKAGE_HOSTS : []), ...(policy.allowMcpServers ? mcpHosts : [])].some(rule => hostMatches(url.hostname, rule));
}

export function decodeVaultPath(value: string): string {
  try { return decodeURIComponent(value); } catch { throw bad("Malformed percent-encoding"); }
}
