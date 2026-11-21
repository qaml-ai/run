import { ApiError } from "../types.ts";

/** How old a Standard Webhooks delivery may be, as their libraries allow. */
const MAX_SKEW_S = 5 * 60;
/** The payload shown in the default prompt; all of it is attached as payload.json. */
const MAX_PROMPT_PAYLOAD = 8_000;
const MAX_TEMPLATE = 4_000;
/** Headers that name a delivery, in order, when the channel names none. */
const ID_HEADERS = ["webhook-id", "x-request-id", "x-delivery-id", "x-github-delivery", "linear-delivery", "idempotency-key"];

const encoder = new TextEncoder();
const utf8 = (text: string) => encoder.encode(text);
const view = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256HexSync(text: string): string {
  const data = utf8(text);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000));
  dv.setUint32(padded.length - 4, (data.length << 3) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((value, i) => { h[i] = (h[i]! + value) >>> 0; });
  }
  return Array.from(h, value => value.toString(16).padStart(8, "0")).join("");
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(clean.padEnd(clean.length + (4 - clean.length % 4) % 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sameText(given: string, expected: string): boolean {
  const a = utf8(given), b = utf8(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}

async function hmacSha256(key: Uint8Array | string, message: Uint8Array | string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", view(typeof key === "string" ? utf8(key) : key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, view(typeof message === "string" ? utf8(message) : message)));
}

export type ChannelSettings = Record<string, unknown>;
export interface InboundFile { id: string; name: string; size?: number; contentType?: string; content?: string }
export interface Inbound {
  conversationId: string;
  messageId: string;
  sender: { id: string; username?: string; name?: string };
  text: string;
  files: InboundFile[];
  title?: string;
}

export type Signature =
  | { type: "standard" }
  | { type: "hmac-sha256"; header: string; prefix?: string; encoding?: "hex" | "base64" }
  | { type: "token"; header: string };

/** One condition on the payload: the value at `path` is one of `in`, equals `equals`, or (`exists`) is present or absent. */
export type Condition = { path: string; in?: (string | number | boolean)[]; equals?: string | number | boolean; exists?: boolean };

export interface WebhookSettings {
  signature: Signature;
  key?: string;
  prompt?: string;
  sender?: string;
  filter?: Condition[];
  idPath?: string;
  idHeader?: string;
}

/** The value at a dotted path: `headers.<name>` reads a request header, `body.<path>` (or any other path) the payload. */
export function lookup(path: string, payload: unknown, headers?: Headers): unknown {
  const trimmed = path.trim();
  if (trimmed.startsWith("headers.")) return headers?.get(trimmed.slice("headers.".length)) ?? undefined;
  let value: unknown = payload;
  for (const part of (trimmed.startsWith("body.") ? trimmed.slice(5) : trimmed === "body" ? "" : trimmed).split(".").filter(Boolean)) {
    if (value === null || typeof value !== "object") return undefined;
    value = Array.isArray(value) && /^\d+$/.test(part) ? value[Number(part)] : Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
  }
  return value;
}

const text = (value: unknown) => value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

/** Fill `{{path}}` placeholders from the payload and headers (see `lookup`); a missing value is empty. */
export function render(template: string, payload: unknown, headers?: Headers): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) => text(lookup(path, payload, headers)));
}

/** Whether every condition holds for the payload. */
export function matches(filter: Condition[] | undefined, payload: unknown, headers?: Headers): boolean {
  return (filter ?? []).every(condition => {
    const value = lookup(condition.path, payload, headers);
    if (condition.exists !== undefined && (value !== undefined && value !== null) !== condition.exists) return false;
    if (condition.equals !== undefined && text(value) !== String(condition.equals)) return false;
    if (condition.in !== undefined && !condition.in.map(String).includes(text(value))) return false;
    return true;
  });
}

/** A rendered key as a conversation id: kept as it is when it fits, else made to fit and told apart by a hash of the original. */
export function conversationKey(value: string): string {
  if (/^[A-Za-z0-9_.-]{1,64}$/.test(value)) return value;
  const cleaned = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 47);
  return `${cleaned || "key"}-${sha256HexSync(value).slice(0, 16)}`;
}

/** A secret's HMAC key: a Standard Webhooks `whsec_` secret is base64 after its prefix; any other is its own bytes. */
const keyOf = (secret: string) => secret.startsWith("whsec_") ? base64Key(secret.slice(6)) : utf8(secret);
const base64Key = (value: string) => {
  const clean = value.split("=")[0]!.replace(/[^A-Za-z0-9+/\-_]/g, "");
  return fromBase64(clean.length % 4 === 1 ? clean.slice(0, -1) : clean);
};

/** Whether a delivery carries a valid signature (or token) under `signature`, made with `secret`. */
export async function verifySignature(signature: Signature, secret: string, headers: Headers, body: string, now = Date.now()): Promise<boolean> {
  if (signature.type === "token") return sameText(headers.get(signature.header) ?? "", secret);
  if (signature.type === "hmac-sha256") {
    const mac = await hmacSha256(keyOf(secret), body);
    const digest = signature.encoding === "base64" ? toBase64(mac) : toHex(mac);
    return sameText(headers.get(signature.header)?.trim() ?? "", `${signature.prefix ?? ""}${digest}`);
  }
  const id = headers.get("webhook-id") ?? "", timestamp = headers.get("webhook-timestamp") ?? "";
  if (!id || !/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_S) return false;
  const expected = `v1,${toBase64(await hmacSha256(keyOf(secret), `${id}.${timestamp}.${body}`))}`;
  return (headers.get("webhook-signature") ?? "").split(" ").some(given => sameText(given, expected));
}

/** Standard Webhooks headers for a body we send, signed with the channel's secret. */
export async function signed(id: string, body: string, secret: string, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${toBase64(await hmacSha256(keyOf(secret), `${id}.${timestamp}.${body}`))}` };
}

const HEADER = /^[A-Za-z0-9-]{1,100}$/;
const badRequest = (message: string) => new ApiError(400, "invalid_request", message);

const template = (value: unknown, name: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEMPLATE) throw badRequest(`settings.${name} must be a template of 1–${MAX_TEMPLATE} characters`);
  return value;
};

/** Validate a webhook channel's settings, `input` merged over `current`. */
export function webhookSettings(input: ChannelSettings | undefined, current?: ChannelSettings): WebhookSettings {
  const merged: Record<string, unknown> = { ...current, ...input };
  for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
  const known = ["signature", "key", "prompt", "sender", "filter", "idPath", "idHeader"];
  const unknown = Object.keys(merged).find(key => !known.includes(key));
  if (unknown) throw badRequest(`Unknown setting ${unknown}; webhook channels take ${known.join(", ")}`);
  const given = (typeof merged.signature === "string" ? { type: merged.signature } : merged.signature ?? { type: "standard" }) as Record<string, unknown>;
  let signature: Signature;
  if (given.type === "standard") signature = { type: "standard" };
  else if (given.type === "hmac-sha256" || given.type === "token") {
    if (typeof given.header !== "string" || !HEADER.test(given.header)) throw badRequest(`settings.signature.header: the header that carries the ${given.type === "token" ? "token" : "signature"}`);
    if (given.type === "token") signature = { type: "token", header: given.header.toLowerCase() };
    else {
      if (given.prefix !== undefined && (typeof given.prefix !== "string" || given.prefix.length > 40)) throw badRequest("settings.signature.prefix must be a short string, e.g. sha256=");
      if (given.encoding !== undefined && given.encoding !== "hex" && given.encoding !== "base64") throw badRequest("settings.signature.encoding is hex or base64");
      signature = { type: "hmac-sha256", header: given.header.toLowerCase(), ...(given.prefix ? { prefix: given.prefix as string } : {}), ...(given.encoding ? { encoding: given.encoding as "hex" | "base64" } : {}) };
    }
  } else throw badRequest("settings.signature.type is standard, hmac-sha256 or token");
  let filter: Condition[] | undefined;
  if (merged.filter !== undefined) {
    const list = Array.isArray(merged.filter) ? merged.filter : [merged.filter];
    if (list.length > 20) throw badRequest("settings.filter takes at most 20 conditions");
    filter = list.map((condition, index) => {
      const at = `settings.filter[${index}]`;
      if (!condition || typeof condition !== "object" || typeof condition.path !== "string" || !condition.path) throw badRequest(`${at}.path: the payload path to test`);
      const scalar = (value: unknown) => ["string", "number", "boolean"].includes(typeof value);
      if (condition.in !== undefined && (!Array.isArray(condition.in) || !condition.in.length || !condition.in.every(scalar))) throw badRequest(`${at}.in: a list of values`);
      if (condition.equals !== undefined && !scalar(condition.equals)) throw badRequest(`${at}.equals: a string, number or boolean`);
      if (condition.exists !== undefined && typeof condition.exists !== "boolean") throw badRequest(`${at}.exists: true or false`);
      if (condition.in === undefined && condition.equals === undefined && condition.exists === undefined) throw badRequest(`${at}: give in, equals or exists`);
      return { path: condition.path, ...(condition.in !== undefined ? { in: condition.in } : {}), ...(condition.equals !== undefined ? { equals: condition.equals } : {}), ...(condition.exists !== undefined ? { exists: condition.exists } : {}) };
    });
  }
  if (merged.idHeader !== undefined && (typeof merged.idHeader !== "string" || !HEADER.test(merged.idHeader))) throw badRequest("settings.idHeader: a header name");
  if (merged.idPath !== undefined && (typeof merged.idPath !== "string" || !merged.idPath)) throw badRequest("settings.idPath: a payload path");
  const key = template(merged.key, "key"), prompt = template(merged.prompt, "prompt"), sender = template(merged.sender, "sender");
  return {
    signature, ...(key ? { key } : {}), ...(prompt ? { prompt } : {}), ...(sender ? { sender } : {}), ...(filter ? { filter } : {}),
    ...(merged.idPath ? { idPath: merged.idPath as string } : {}), ...(merged.idHeader ? { idHeader: (merged.idHeader as string).toLowerCase() } : {}),
  };
}

/** A delivery as a message, or undefined when the filter leaves it out. */
export function webhookInbound(payload: unknown, headers: Headers, settings: WebhookSettings): Inbound | undefined {
  if (!matches(settings.filter, payload, headers)) return undefined;
  const json = JSON.stringify(payload, null, 2);
  const id = settings.idPath ? text(lookup(settings.idPath, payload)) : settings.idHeader ? headers.get(settings.idHeader) ?? "" : ID_HEADERS.map(name => headers.get(name)).find(Boolean) ?? "";
  const key = settings.key ? render(settings.key, payload, headers).trim() : "";
  const sender = settings.sender ? render(settings.sender, payload, headers).trim().slice(0, 200) : "";
  const shown = json.length > MAX_PROMPT_PAYLOAD ? `${json.slice(0, MAX_PROMPT_PAYLOAD)}\n…(truncated; all of it is in payload.json)` : json;
  const prompt = settings.prompt ? render(settings.prompt, payload, headers).trim() : `A webhook delivery arrived:\n\`\`\`json\n${shown}\n\`\`\``;
  const content = utf8(json);
  return {
    conversationId: conversationKey(key || "default"),
    messageId: id ? `id:${id}` : `sha:${sha256HexSync(json)}`,
    sender: { id: sender || "webhook" },
    text: prompt || "(an empty delivery)",
    files: [{ id: "payload.json", name: "payload.json", size: content.length, contentType: "application/json", content: toBase64(content) }],
    ...(key ? { title: key.slice(0, 100) } : {}),
  };
}
