import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.ts";
import type { Outbound } from "./outbound.ts";
import { errorText } from "./protocol.ts";
import { SendError, type ChannelProvider, type ChannelSettings, type Inbound } from "./channels.ts";

/** How old a Standard Webhooks delivery may be, as their libraries allow. */
const MAX_SKEW_S = 5 * 60;
const MAX_BODY_BYTES = 1024 * 1024;
/** The payload shown in the default prompt; all of it is attached as payload.json. */
const MAX_PROMPT_PAYLOAD = 8_000;
const MAX_TEMPLATE = 4_000;
/** Headers that name a delivery, in order, when the channel names none. */
const ID_HEADERS = ["webhook-id", "x-request-id", "x-delivery-id", "x-github-delivery", "linear-delivery", "idempotency-key"];

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export type Signature =
  | { type: "standard" }
  | { type: "hmac-sha256"; header: string; prefix?: string; encoding?: "hex" | "base64" }
  | { type: "token"; header: string };
/** One condition on the payload: the value at `path` is one of `in`, equals `equals`, or (`exists`) is present or absent. */
export type Condition = { path: string; in?: (string | number | boolean)[]; equals?: string | number | boolean; exists?: boolean };
export interface WebhookSettings {
  signature: Signature;
  /** The conversation each delivery belongs to (one agent each), e.g. "sentry-{{data.issue.id}}"; one conversation when unset. */
  key?: string;
  /** The prompt; by default the payload itself. */
  prompt?: string;
  /** Who the delivery is from, e.g. "{{actor.email}}"; "webhook" when unset. */
  sender?: string;
  /** Every condition must hold, or the delivery is acknowledged and ignored. */
  filter?: Condition[];
  /** Where the delivery's id is, for dropping repeats: a payload path, or a header. */
  idPath?: string; idHeader?: string;
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
  return `${cleaned || "key"}-${sha(value).slice(0, 16)}`;
}

/** A secret's HMAC key: a Standard Webhooks `whsec_` secret is base64 after its prefix; any other is its own bytes. */
const keyOf = (secret: string) => secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
const same = (given: string, expected: string) => {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Whether a delivery carries a valid signature (or token) under `signature`, made with `secret`. */
export function verifySignature(signature: Signature, secret: string, headers: Headers, body: string, now = Date.now()): boolean {
  if (signature.type === "token") return same(headers.get(signature.header) ?? "", secret);
  if (signature.type === "hmac-sha256") {
    const digest = createHmac("sha256", keyOf(secret)).update(body).digest(signature.encoding ?? "hex");
    return same(headers.get(signature.header)?.trim() ?? "", `${signature.prefix ?? ""}${digest}`);
  }
  const id = headers.get("webhook-id") ?? "", timestamp = headers.get("webhook-timestamp") ?? "";
  if (!id || !/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_S) return false;
  const expected = `v1,${createHmac("sha256", keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
  // Several signatures, space-separated, while a sender rotates its secret.
  return (headers.get("webhook-signature") ?? "").split(" ").some(given => same(given, expected));
}

/** Standard Webhooks headers for a body we send, signed with the channel's secret. */
export function signed(id: string, body: string, secret: string, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${createHmac("sha256", keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}` };
}

const HEADER = /^[A-Za-z0-9-]{1,100}$/;
const template = (value: unknown, name: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEMPLATE) throw new HttpError(400, `settings.${name} must be a template of 1–${MAX_TEMPLATE} characters`);
  return value;
};

/** Validate a webhook channel's settings, `input` merged over `current`. */
export function webhookSettings(input: ChannelSettings | undefined, current?: ChannelSettings): WebhookSettings {
  const merged: Record<string, unknown> = { ...current, ...input };
  for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
  const known = ["signature", "key", "prompt", "sender", "filter", "idPath", "idHeader"];
  const unknown = Object.keys(merged).find(key => !known.includes(key));
  if (unknown) throw new HttpError(400, `Unknown setting ${unknown}; webhook channels take ${known.join(", ")}`);
  const given = (typeof merged.signature === "string" ? { type: merged.signature } : merged.signature ?? { type: "standard" }) as Record<string, unknown>;
  let signature: Signature;
  if (given.type === "standard") signature = { type: "standard" };
  else if (given.type === "hmac-sha256" || given.type === "token") {
    if (typeof given.header !== "string" || !HEADER.test(given.header)) throw new HttpError(400, `settings.signature.header: the header that carries the ${given.type === "token" ? "token" : "signature"}`);
    if (given.type === "token") signature = { type: "token", header: given.header.toLowerCase() };
    else {
      if (given.prefix !== undefined && (typeof given.prefix !== "string" || given.prefix.length > 40)) throw new HttpError(400, "settings.signature.prefix must be a short string, e.g. sha256=");
      if (given.encoding !== undefined && given.encoding !== "hex" && given.encoding !== "base64") throw new HttpError(400, "settings.signature.encoding is hex or base64");
      signature = { type: "hmac-sha256", header: given.header.toLowerCase(), ...(given.prefix ? { prefix: given.prefix as string } : {}), ...(given.encoding ? { encoding: given.encoding as "hex" | "base64" } : {}) };
    }
  } else throw new HttpError(400, "settings.signature.type is standard, hmac-sha256 or token");
  let filter: Condition[] | undefined;
  if (merged.filter !== undefined) {
    const list = Array.isArray(merged.filter) ? merged.filter : [merged.filter];
    if (list.length > 20) throw new HttpError(400, "settings.filter takes at most 20 conditions");
    filter = list.map((condition, index) => {
      const at = `settings.filter[${index}]`;
      if (!condition || typeof condition !== "object" || typeof condition.path !== "string" || !condition.path) throw new HttpError(400, `${at}.path: the payload path to test`);
      const scalar = (value: unknown) => ["string", "number", "boolean"].includes(typeof value);
      if (condition.in !== undefined && (!Array.isArray(condition.in) || !condition.in.length || !condition.in.every(scalar))) throw new HttpError(400, `${at}.in: a list of values`);
      if (condition.equals !== undefined && !scalar(condition.equals)) throw new HttpError(400, `${at}.equals: a string, number or boolean`);
      if (condition.exists !== undefined && typeof condition.exists !== "boolean") throw new HttpError(400, `${at}.exists: true or false`);
      if (condition.in === undefined && condition.equals === undefined && condition.exists === undefined) throw new HttpError(400, `${at}: give in, equals or exists`);
      return { path: condition.path, ...(condition.in !== undefined ? { in: condition.in } : {}), ...(condition.equals !== undefined ? { equals: condition.equals } : {}), ...(condition.exists !== undefined ? { exists: condition.exists } : {}) };
    });
  }
  if (merged.idHeader !== undefined && (typeof merged.idHeader !== "string" || !HEADER.test(merged.idHeader))) throw new HttpError(400, "settings.idHeader: a header name");
  if (merged.idPath !== undefined && (typeof merged.idPath !== "string" || !merged.idPath)) throw new HttpError(400, "settings.idPath: a payload path");
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
  const content = Buffer.from(json);
  return {
    conversationId: conversationKey(key || "default"),
    // The body's hash when nothing names the delivery: an identical retry is still dropped.
    messageId: id ? `id:${id}` : `sha:${sha(json)}`,
    sender: { id: sender || "webhook" },
    text: prompt || "(an empty delivery)",
    files: [{ id: "payload.json", name: "payload.json", size: content.length, contentType: "application/json", content: content.toString("base64") }],
    ...(key ? { title: key.slice(0, 100) } : {}),
  };
}

/**
 * Any service that sends webhooks: Sentry, Linear, Stripe, your own. Each delivery proves itself
 * with the secret the tenant gives (a Standard Webhooks signature, an HMAC of the body in a header,
 * or a token), is matched against the channel's filter, and becomes a prompt to the agent its key
 * template picks. There is no conversation to answer: the turn acts through its tools, and its end
 * is on the runs API and outbound webhooks. With `replyUrl` the reply is also posted there, signed.
 */
export function webhook(options: { outbound: Outbound }): ChannelProvider {
  const secretOf = (credentials: Record<string, string>) => {
    const value = credentials.secret;
    if (typeof value !== "string" || value.length < 16 || value.length > 1024) throw new HttpError(400, "Send credentials.secret: the sender's signing secret or token (at least 16 characters)");
    return value;
  };
  async function post(credentials: Record<string, string>, body: Record<string, unknown>) {
    const url = credentials.replyUrl;
    if (!url) return;
    const id = `msg_${randomUUID().replaceAll("-", "")}`;
    const json = JSON.stringify(body);
    let response: Response;
    try {
      response = await options.outbound.fetch(url, { method: "POST", body: json, timeoutMs: 15_000, maxBytes: 64 * 1024, headers: { "Content-Type": "application/json", ...signed(id, json, secretOf(credentials)) } });
    } catch (error) { throw new SendError(`Reply POST failed: ${errorText(error)}`, false); }
    await response.arrayBuffer().catch(() => {});
    if (response.ok) return;
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new SendError(`Reply POST failed: HTTP ${response.status}`, response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status), retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  return {
    label: "Webhook",
    maxMessageLength: 32_000,
    maxBodyBytes: MAX_BODY_BYTES,
    // The signature is the gate; a sender is whatever the delivery says it is.
    defaults: { access: { public: true }, limits: { perSenderPerMinute: 60 } },
    async setup(credentials) {
      const secret = secretOf(credentials);
      const extra = Object.keys(credentials).find(key => key !== "secret" && key !== "replyUrl");
      if (extra) throw new HttpError(400, `Unknown credential ${extra}; webhook channels take secret and replyUrl`);
      if (credentials.replyUrl !== undefined) {
        try { options.outbound.check(credentials.replyUrl); } catch (error) { throw new HttpError(400, `credentials.replyUrl: ${errorText(error)}`); }
      }
      return { account: {}, masked: { secret: `…${secret.slice(-4)}`, ...(credentials.replyUrl ? { replyUrl: new URL(credentials.replyUrl).origin } : {}) } };
    },
    async teardown() {},
    settings: (input, current) => webhookSettings(input, current) as unknown as ChannelSettings,
    verify(headers, body, _secret, credentials, settings) {
      return verifySignature(webhookSettings(settings).signature, secretOf(credentials), headers, body);
    },
    parse(payload, context) { return webhookInbound(payload, context.headers, webhookSettings(context.settings)); },
    async download() { throw new Error("Webhook deliveries carry their files inline"); },
    send: (credentials, conversationId, text) => post(credentials, { type: "message", conversationId, text }),
    maxFileBytes: 0,
    // Too large for any service: the core sends a link instead, which goes to replyUrl as text.
    async sendFile() {},
  };
}
