import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Accounts, Sealed } from "./accounts.ts";
import type { AgentRef, SessionHooks } from "./client-sessions.ts";
import type { ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import { valueServer } from "./tool-servers.ts";
import type { Definitions } from "./definitions.ts";
import { HttpError, readText } from "./http.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { PreconditionFailed } from "../shared/storage.ts";
import { transaction, type Db } from "./db.ts";
import { underClaim, type Claim, type Ownership } from "./ownership.ts";
import { validFileRef, type FileRef } from "./files.ts";
import type { Input } from "./inputs.ts";

/**
 * Channels let people talk to agents through messaging services. Each external
 * conversation gets its own agent, created on first contact from the channel's
 * definition; a message becomes a prompt, and the turn's reply goes back the same way.
 * Messages arrive by webhook (Telegram, Slack) or over a socket that one node holds
 * for the channel (Discord). Everything is in Postgres, so any node can take a
 * webhook or send a reply:
 *
 *   channels                the channel: its definition, access, limits, sealed credentials
 *   channel_conversations   the agent answering one external conversation
 *   channel_agents          the conversation an agent answers
 *   channel_items           live work: an inbound message until its reply is sent, or an outbound message
 *   channel_seen            inbound messages already recorded, so provider retries are dropped
 *   channel_counts          rate-limit and daily-turn counters
 *
 * Items move received → submitted → sending by writes conditional on their
 * revision, and whoever holds an item's claim is the only node advancing it, so a
 * reply is sent once.
 *
 * Attachments are streamed into the agent's workspace and the prompt refers to them by
 * path; files the agent presents (or sends with send_message) go out after the reply's
 * text, each a step of the item's durable progress, so a retry resumes after the last one sent.
 */
export interface Sender { id: string; username?: string; name?: string }
export interface Inbound {
  conversationId: string;
  /** The provider's id for this message, unique within the channel; retries repeat it. */
  messageId: string;
  sender: Sender; text: string;
  /** Attachments, fetched when the message is processed. */
  files: InboundFile[];
  command?: "start";
  /** Only handled when the conversation already has an agent: a reply in a thread that does not mention the bot. */
  continuation?: boolean;
}
/** An attachment: `id` is the provider's reference to fetch it by; `size` and `contentType` as the service declares them. */
export interface InboundFile { id: string; name: string; size?: number; contentType?: string }
/** A file going out, read from its volume (a chunk at a time) when it is sent: at most the service's `maxFileBytes`. */
export interface OutboundFile { name: string; contentType: string; size: number; blob(): Promise<Blob> }
type Credentials = Record<string, string>;
/**
 * What the core needs from a messaging service; everything provider-specific lives behind it.
 * A service delivers messages either to a webhook (`verify` and `parse`) or over a socket (`connect`).
 */
export interface ChannelProvider {
  readonly label: string;
  readonly maxMessageLength: number;
  /** Validate credentials and, where the service allows it, point its webhook at `webhook.url`. */
  setup(credentials: Credentials, webhook: { url: string; secret: string }): Promise<{ account: Record<string, string>; masked: Record<string, string> }>;
  teardown(credentials: Credentials): Promise<void>;
  /** Whether a webhook delivery is genuine, proven with the channel's random secret or a credential the service signs with. */
  verify?(headers: Headers, body: string, secret: string, credentials: Credentials): boolean;
  /** What to answer a verified delivery that is a handshake (a URL-verification challenge) rather than a message. */
  handshake?(body: unknown): object | undefined;
  /** An inbound message, or undefined for updates the channel ignores. */
  parse?(body: unknown): Inbound | undefined;
  /** Hold a connection that delivers the channel's messages, reconnecting on its own, until closed. */
  connect?(credentials: Credentials, handlers: GatewayHandlers): Gateway;
  /** An attachment's bytes, from the service's own file host only. */
  download(credentials: Credentials, file: InboundFile): Promise<{ body: AsyncIterable<Uint8Array>; contentType?: string }>;
  /** The largest attachment a bot may download, when the service caps it below CHANNEL_FILE_LIMITS.fileBytes. */
  readonly maxDownloadBytes?: number;
  send(credentials: Credentials, conversationId: string, text: string): Promise<void>;
  sendFile(credentials: Credentials, conversationId: string, file: OutboundFile, caption?: string): Promise<void>;
  /** The largest file the service takes from a bot; larger ones are sent as a link. */
  readonly maxFileBytes: number;
  /** Show that a reply is coming; a service without an indicator leaves it out. */
  typing?(credentials: Credentials, conversationId: string): Promise<void>;
  /** How often the indicator is refreshed while a turn runs (default 4 s). */
  readonly typingMs?: number;
}
export interface GatewayHandlers {
  /** Structured transport diagnostics; never message content, credentials or session tokens. */
  diagnostic?(event: string, fields: Record<string, unknown>): void;
  message(inbound: Inbound): Promise<void>;
  /** The connection cannot work (credentials rejected); it is retried after a pause. */
  failed(error: Error): void;
}
export interface Gateway { close(): void }
/** A failed send; permanent failures (blocked bot, unknown chat) are not retried. */
export class SendError extends Error {
  permanent: boolean; retryAfterMs?: number;
  constructor(message: string, permanent: boolean, retryAfterMs?: number) { super(message); this.permanent = permanent; this.retryAfterMs = retryAfterMs; }
}

export interface Channel {
  id: string; tenant: string; type: string; name: string;
  /** Where the service delivers messages; channels that receive over a socket have none. */
  webhookUrl?: string;
  /** What each conversation's agent is made from. */
  definition: string;
  /** Senders by id or @username; `public` lets anyone in. */
  access: { public: boolean; allow: string[] };
  limits: { perSenderPerMinute: number; turnsPerDay: number };
  greeting?: string;
  account: Record<string, string>;
  masked: Record<string, string>;
  sealed: Sealed;
  createdAt: number; updatedAt: number;
}
export type ChannelInput = Partial<Pick<Channel, "name" | "definition" | "greeting">> & {
  type?: string; credentials?: Credentials;
  access?: Partial<Channel["access"]>; limits?: Partial<Channel["limits"]>;
};
type Binding = { channel: string; tenant: string; conversationId: string };
type Item = {
  id: string; channel: string; tenant: string; conversationId: string; createdAt: number;
  state: "received" | "submitted" | "sending";
  /** Not before this time: the next retry or re-check. */
  due: number;
  inbound?: Inbound;
  agent?: string; prompt?: { text: string; from?: { id: string; name?: string; username?: string }; files?: { path: string }[] };
  /** What to send: the text's parts, then each file; `sent` counts the steps done. */
  text?: string; files?: Presented[]; sent?: number; attempts?: number;
};
/** A file for the conversation, as `present_file` or send_message gave it. */
type Presented = FileRef & { caption?: string };
/** An item as last written; the next write is conditional on its revision. */
type Held = { item: Item; revision: number };

export const SEND_MESSAGE: ToolDefinition = {
  name: "send_message",
  description: "Send a message to the person you are talking with right away, before your final reply: for progress updates during long work, or files. Your final reply is sent automatically; do not repeat it here.",
  parameters: { type: "object", properties: {
    text: { type: "string", maxLength: 16_000 },
    files: { type: "array", maxItems: 10, items: { type: "string" }, description: "Paths of files in your mounts to send, e.g. /workspace/report.pdf" },
  }, additionalProperties: false },
  exposure: "direct",
};
/**
 * Attachments a message brings in, saved to the agent's workspace: at most `files` of them,
 * each at most `fileBytes` and `messageBytes` in all, each downloaded within `downloadMs`.
 */
export const CHANNEL_FILE_LIMITS = Object.freeze({ files: 10, fileBytes: 25 * 1024 * 1024, messageBytes: 100 * 1024 * 1024, downloadMs: 60_000 });
const DEFAULT_LIMITS = { perSenderPerMinute: 10, turnsPerDay: 1_000 };
const DEFAULT_GREETING = "Hi! Send me a message to get started.";
const FAILED_REPLY = "Sorry, something went wrong while answering. Please try again.";
/** A claim older than this is assumed abandoned by a crashed node and may be retaken. */
const CLAIM_MS = 60_000;
/** How often a submitted message's turn is checked when its end was not observed (a crash). */
const RECHECK_MS = 60_000;
const CLAIM_BATCH = 100;
/** Provider retries come within minutes; seen markers and counters are pruned after this. */
const SEEN_DAYS = 7;
const PRUNE_EVERY_MS = 60 * 60_000;
const MAX_ATTEMPTS = 8;
const MAX_REPLY = 32_000;
const TYPING_MS = 4_000;
/** How long a gateway whose credentials were rejected waits before trying again. */
const GATEWAY_RETRY_MS = 5 * 60_000;

/** Fetch an attachment from a service's file host: never redirected (a token may go with it), within a time limit. */
export async function fetchFile(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(CHANNEL_FILE_LIMITS.downloadMs) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  return { body: response.body as AsyncIterable<Uint8Array>, contentType: response.headers.get("content-type")?.split(";")[0] };
}
/** A file's size for people. */
export const sizeText = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const held = (row: any): Held => ({ item: { ...row.item, due: row.due }, revision: row.revision });
const validConversation = (value: string) => /^[A-Za-z0-9_.-]{1,64}$/.test(value);

/** Split text for a service's message limit, at a line or word break when one is near. */
export function chunks(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY)}…` : text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = /[\uD800-\uDBFF]/.test(rest[max - 1]) ? max - 1 : max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

export interface ChannelsOptions {
  db: Db; accounts: Accounts; definitions: Definitions; node: string; publicUrl: string;
  providers: Record<string, ChannelProvider>;
  /** Decides which node holds each gateway channel's connection; without it no gateway connects. */
  ownership?: Ownership;
  createAgent(tenant: string, params: any, key: string): Promise<{ id: string }>;
  /** The id `createAgent` gives the agent for a key, so the conversation is bound before the agent starts. */
  agentId(tenant: string, key: string): string;
  /** Whether the agent still exists and is the tenant's. */
  live(agent: string, tenant: string): Promise<boolean>;
  /** Submit a request to an agent on whichever node serves it. */
  submit(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }): Promise<RequestRecord>;
  /** Files in and out of agents' volumes; without it attachments are noted but not saved, and files are not sent. */
  files?: ChannelFiles;
  /** Human input an agent waits on: its pending inputs, oldest first, and answering one (as its sender, who must be allowed to). */
  inputs?: {
    pending(agent: string): Promise<Input[]>;
    answer(agent: string, tenant: string, input: string, answer: { action: "accept" | "decline"; content?: unknown; from: { id: string; name?: string; username?: string } }): Promise<unknown>;
  };
  retryBaseMs?: number;
}
export interface ChannelFiles {
  /** Save an attachment for request `requestId` in the agent's workspace. */
  upload(agent: string, tenant: string, requestId: string, name: string, source: AsyncIterable<Uint8Array>, contentType?: string): Promise<{ path: string }>;
  /** A file in the agent's mounts, as a reference; rejects paths outside them. */
  ref(agent: string, tenant: string, path: string): Promise<FileRef>;
  read(tenant: string, ref: FileRef): AsyncIterable<Uint8Array>;
  /** A download link to a file in the agent's mounts, lasting as long as links may. */
  link(agent: string, tenant: string, path: string): Promise<string>;
}

export class Channels {
  readonly db: Db;
  private readonly options: ChannelsOptions;
  private readonly bindings = new Map<string, Promise<Binding | undefined>>();
  private readonly typing = new Map<string, ReturnType<typeof setInterval>>();
  private readonly gateways = new Map<string, { claim: Claim; updatedAt: number; gateway: Gateway }>();
  private readonly gatewayRetry = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private prunedAt = 0;

  constructor(options: ChannelsOptions) {
    this.options = options;
    this.db = options.db;
    // A fenced node's claims are void: another node connects while this one is cut off.
    options.ownership?.onFence(() => { for (const id of [...this.gateways.keys()]) this.closeGateway(id, false); });
  }

  start(intervalMs = 5_000) {
    this.timer ??= setInterval(() => void this.scan().catch(error => console.error(JSON.stringify({ type: "channel_scan_failed", error: errorText(error) }))), intervalMs);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    for (const id of [...this.gateways.keys()]) this.closeGateway(id, true);
  }

  // Configuration ---------------------------------------------------------------

  private provider(type: string) {
    const provider = Object.hasOwn(this.options.providers, type) ? this.options.providers[type] : undefined;
    if (!provider) throw new HttpError(400, `Unknown channel type ${type}; supported: ${Object.keys(this.options.providers).join(", ")}`);
    return provider;
  }
  private async read(id: string) {
    if (!/^ch_[a-f0-9]{20}$/.test(id)) return undefined;
    return (await this.db.query("select channel from channels where id = $1", [id])).rows[0]?.channel as Channel | undefined;
  }
  private async owned(tenant: string, id: string) {
    const channel = await this.read(id);
    if (!channel || channel.tenant !== tenant) throw new HttpError(404, "Unknown channel");
    return channel;
  }
  private secrets(channel: Channel): { credentials: Credentials; secret: string } {
    return JSON.parse(this.options.accounts.unseal(`channel:${channel.id}`, channel.sealed));
  }
  /** Credentials never leave the runtime: callers see a masked form. */
  view({ sealed: _sealed, masked, ...channel }: Channel) { return { ...channel, credentials: masked }; }

  async list(tenant: string) {
    const { rows } = await this.db.query("select channel from channels where tenant = $1 order by created_at, id", [tenant]);
    return rows.map(row => this.view(row.channel));
  }
  async get(tenant: string, id: string) { return this.view(await this.owned(tenant, id)); }

  async create(tenant: string, input: ChannelInput) {
    if (!this.options.accounts.canStoreKeys) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot store channel credentials");
    const type = input.type ?? "";
    const provider = this.provider(type);
    if (!input.credentials) throw new HttpError(400, "A channel needs credentials");
    const id = `ch_${randomBytes(10).toString("hex")}`;
    const secret = randomBytes(32).toString("hex");
    const webhookUrl = `${this.options.publicUrl}/channels/${type}/${id}`;
    const settings = this.settings(input);
    const { account, masked } = await provider.setup(input.credentials, { url: webhookUrl, secret });
    const now = Date.now();
    const name = input.name ?? `${provider.label} ${account.username ? `@${account.username}` : id}`;
    const channel: Channel = {
      id, tenant, type, name, ...(provider.verify ? { webhookUrl } : {}),
      definition: await this.definition(tenant, id, name, input), access: { public: false, allow: [], ...settings.access }, limits: { ...DEFAULT_LIMITS, ...settings.limits },
      ...(settings.greeting ? { greeting: settings.greeting } : {}), account, masked,
      sealed: this.options.accounts.seal(`channel:${id}`, JSON.stringify({ credentials: input.credentials, secret })), createdAt: now, updatedAt: now,
    };
    await this.db.query("insert into channels (id, tenant, channel, created_at) values ($1, $2, $3, $4)", [id, tenant, JSON.stringify(channel), now]);
    return this.view(channel);
  }

  async update(tenant: string, id: string, input: ChannelInput) {
    const channel = await this.owned(tenant, id);
    if (input.type !== undefined && input.type !== channel.type) throw new HttpError(400, "A channel's type cannot change");
    const settings = this.settings(input);
    const next: Channel = {
      ...channel, ...(input.name !== undefined ? { name: input.name } : {}),
      definition: await this.definition(tenant, id, input.name ?? channel.name, input, channel.definition),
      access: { ...channel.access, ...settings.access }, limits: { ...channel.limits, ...settings.limits },
      ...(settings.greeting !== undefined ? { greeting: settings.greeting } : {}), updatedAt: Date.now(),
    };
    if (input.credentials) {
      const provider = this.provider(channel.type);
      const old = this.secrets(channel).credentials;
      const secret = randomBytes(32).toString("hex");
      Object.assign(next, await provider.setup(input.credentials, { url: `${this.options.publicUrl}/channels/${channel.type}/${id}`, secret }));
      next.sealed = this.options.accounts.seal(`channel:${id}`, JSON.stringify({ credentials: input.credentials, secret }));
      // A different bot keeps its webhook pointed here otherwise.
      if (next.account.id !== channel.account.id) await provider.teardown(old).catch(() => {});
    }
    await this.db.query("update channels set channel = $2 where id = $1", [id, JSON.stringify(next)]);
    return this.view(next);
  }

  async remove(tenant: string, id: string) {
    const channel = await this.owned(tenant, id);
    try { await this.provider(channel.type).teardown(this.secrets(channel).credentials); }
    catch (error) { console.error(JSON.stringify({ type: "channel_teardown_failed", channel: id, error: errorText(error) })); }
    await this.db.query("delete from channels where id = $1 and tenant = $2", [id, tenant]);
    // A definition made for the channel goes with it, unless another channel took it up.
    if ((await this.options.definitions.read(tenant, channel.definition).catch(() => undefined))?.spec.channel === id) {
      await this.options.definitions.remove(tenant, channel.definition).catch(() => {});
    }
  }

  private settings(input: ChannelInput) {
    return { access: input.access, limits: input.limits, greeting: input.greeting };
  }

  /**
   * The definition a channel's agents are made from: the one named, else the one it has,
   * else (a new channel given none) an empty definition of the channel's own.
   */
  private async definition(tenant: string, id: string, name: string, input: ChannelInput, current?: string): Promise<string> {
    if (input.definition !== undefined) return (await this.options.definitions.read(tenant, input.definition)).id;
    return current ?? (await this.options.definitions.create(tenant, { name: name.slice(0, 120) }, { channel: id })).id;
  }

  // Inbound ---------------------------------------------------------------------

  /** Public webhooks, mounted before any authentication: each request proves itself with the channel's secret. */
  readonly app = new Hono().post("/channels/:type/:id", async c => {
    const channel = await this.read(c.req.param("id"));
    if (!channel || channel.type !== c.req.param("type")) return c.body(null, 404);
    let body: string;
    try { body = await readText(c.req.raw.body, 1_000_000); } catch { return c.body(null, 413); }
    const provider = this.provider(channel.type);
    if (!provider.verify || !provider.parse) return c.body(null, 404);
    const { credentials, secret } = this.secrets(channel);
    if (!provider.verify(c.req.raw.headers, body, secret, credentials)) return c.body(null, 401);
    let payload: unknown, inbound: Inbound | undefined;
    try { payload = JSON.parse(body); } catch { return c.body(null, 400); }
    const handshake = provider.handshake?.(payload);
    if (handshake) return c.json(handshake);
    try { inbound = provider.parse(payload); } catch { return c.body(null, 400); }
    if (inbound) await this.accept(channel, inbound);
    return c.body(null, 200);
  });

  /** Record a message and start on it. Anything the channel does not handle, or from someone not allowed, is dropped. */
  private async accept(channel: Channel, inbound: Inbound) {
    if (!validConversation(inbound.conversationId) || !this.allowed(channel, inbound.sender)) {
      console.log(JSON.stringify({ type: "channel_message_rejected", channel: channel.id, messageId: inbound.messageId,
        reason: !validConversation(inbound.conversationId) ? "invalid_conversation" : "access" }));
      return;
    }
    if (inbound.continuation) {
      const known = await this.db.query("select 1 from channel_conversations where channel = $1 and conversation = $2", [channel.id, inbound.conversationId]);
      if (!known.rowCount) return;
    }
    const recorded = await this.record(channel, inbound);
    if (recorded) void this.advance(recorded).catch(error => this.failed(recorded.item, error));
  }

  allowed(channel: Channel, sender: Sender) {
    if (channel.access.public) return true;
    const username = sender.username?.toLowerCase();
    return channel.access.allow.some(entry => {
      const normalized = entry.trim().replace(/^@/, "");
      // Ids match exactly (Slack's are upper case); usernames in any case.
      return normalized === sender.id || (!!username && normalized.toLowerCase() === username);
    });
  }

  /** Durably record a message before acknowledging it, claimed by this node; undefined for one already recorded. */
  private record(channel: Channel, inbound: Inbound) {
    const now = Date.now();
    const item: Item = {
      id: `in_${sha(`${channel.id}:${inbound.messageId}`).slice(0, 40)}`, channel: channel.id, tenant: channel.tenant, conversationId: inbound.conversationId,
      createdAt: now, state: "received", due: now, inbound,
    };
    // The seen marker and the item commit together, so a retried delivery finds one or the other.
    return transaction(this.db, async sql => {
      const seen = await sql.query("insert into channel_seen (channel, message) values ($1, $2) on conflict do nothing", [channel.id, sha(inbound.messageId).slice(0, 40)]);
      if (!seen.rowCount) return undefined;
      return this.insert(sql, item);
    });
  }

  private async insert(sql: Pick<Db, "query">, item: Item): Promise<Held | undefined> {
    const { due, ...stored } = item;
    const { rows } = await sql.query(`
      insert into channel_items (id, item, due, claimed_by, claimed_until) values ($1, $2, $3, $4, now() + $5 * interval '1 millisecond')
      on conflict (id) do nothing returning revision`, [item.id, JSON.stringify(stored), due, this.options.node, CLAIM_MS]);
    return rows[0] && { item, revision: rows[0].revision };
  }

  // Gateways --------------------------------------------------------------------

  /**
   * A service that pushes messages over a socket (Discord) needs one connection per
   * channel. Each is an actor in `actor_owners`, so one node holds it, and when that
   * node dies or fences the next node's scan takes it. Two connections for a moment
   * during a takeover are harmless: messages are recorded once by id.
   */
  private async connectGateways() {
    const ownership = this.options.ownership;
    const types = Object.keys(this.options.providers).filter(type => this.options.providers[type].connect);
    if (!ownership || !types.length) return;
    const { rows } = await this.db.query("select channel from channels where channel->>'type' = any($1)", [types]);
    const wanted = new Map(rows.map(row => [row.channel.id as string, row.channel as Channel]));
    for (const [id, held] of this.gateways) {
      const channel = wanted.get(id);
      if (!ownership.holds(held.claim)) this.closeGateway(id, false);
      // Deleted, or changed (credentials, access): reconnect with what is stored now.
      else if (channel?.updatedAt !== held.updatedAt) this.closeGateway(id, !channel);
    }
    for (const id of this.gatewayRetry.keys()) if (!wanted.has(id)) this.gatewayRetry.delete(id);
    for (const channel of wanted.values()) {
      if (this.gateways.has(channel.id) || ownership.draining || (this.gatewayRetry.get(channel.id) ?? 0) > Date.now()) continue;
      const taken = await ownership.acquire(`gateway:${channel.id}`).catch(() => undefined);
      if (!taken || !("claim" in taken)) continue;
      const { claim } = taken;
      const current = () => this.gateways.get(channel.id)?.claim === claim;
      console.log(JSON.stringify({ type: "channel_gateway_acquired", channel: channel.id, node: this.options.node, epoch: claim.epoch }));
      const gateway = this.provider(channel.type).connect!(this.secrets(channel).credentials, {
        diagnostic: (event, fields) => console.log(JSON.stringify({ type: `${channel.type}_gateway_${event}`, channel: channel.id, node: this.options.node, epoch: claim.epoch, ...fields })),
        message: async inbound => {
          const latest = await this.read(channel.id);
          if (latest && current()) await this.accept(latest, inbound);
          else console.log(JSON.stringify({ type: "channel_gateway_message_skipped", channel: channel.id, node: this.options.node, reason: latest ? "stale_claim" : "deleted" }));
        },
        // Kept claimed, so no other node tries the same credentials; this node retries after a pause.
        failed: error => {
          console.error(JSON.stringify({ type: "channel_gateway_failed", channel: channel.id, error: errorText(error) }));
          this.gatewayRetry.set(channel.id, Date.now() + GATEWAY_RETRY_MS);
          if (current()) this.closeGateway(channel.id, false);
        },
      });
      this.gateways.set(channel.id, { claim, updatedAt: channel.updatedAt, gateway });
    }
  }

  /** Close a channel's connection; releasing it lets any node take it at once. */
  private closeGateway(id: string, release: boolean) {
    const held = this.gateways.get(id);
    if (!held) return;
    console.log(JSON.stringify({ type: "channel_gateway_released", channel: id, node: this.options.node, epoch: held.claim.epoch,
      release, draining: this.options.ownership?.draining ?? false, holds: this.options.ownership?.holds(held.claim) ?? false }));
    this.gateways.delete(id);
    held.gateway.close();
    if (release) void this.options.ownership?.release(held.claim).catch(() => {});
  }

  // Work items ------------------------------------------------------------------

  /** Advance every item that is due and unclaimed; any node may run this. */
  async scan(now = Date.now()) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.connectGateways().catch(error => console.error(JSON.stringify({ type: "channel_gateways_failed", error: errorText(error) })));
      await this.prune();
      for (let batch; (batch = await this.claim(now)).length;) {
        for (const claimed of batch) await this.advance(claimed).catch(error => this.failed(claimed.item, error));
        if (batch.length < CLAIM_BATCH) break;
      }
    } finally { this.scanning = false; }
  }

  private async claim(now: number): Promise<Held[]> {
    const { rows } = await this.db.query(`
      update channel_items set claimed_by = $2, claimed_until = now() + $3 * interval '1 millisecond', revision = revision + 1
      where id in (
        select id from channel_items where due <= $1 and (claimed_until is null or claimed_until <= now())
        order by due limit ${CLAIM_BATCH} for update skip locked)
      returning item, due, revision`, [now, this.options.node, CLAIM_MS]);
    return rows.map(held);
  }

  /** Forget seen markers and counters once no retry or window can need them. */
  private async prune() {
    if (Date.now() - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = Date.now();
    await this.db.query(`delete from channel_seen where seen_at < now() - interval '${SEEN_DAYS} days'`);
    await this.db.query("delete from channel_counts where created_at < now() - interval '2 days'");
  }

  /**
   * Write the next state of an item this node holds; the revision check fences out
   * anyone who retook it. `claim` true extends this node's claim, false releases it.
   */
  private async save({ item, revision }: Held, changes: Partial<Item>, claim?: boolean): Promise<Held> {
    const next = { ...item, ...changes };
    for (const key of Object.keys(changes) as (keyof Item)[]) if (changes[key] === undefined) delete next[key];
    const { due, ...stored } = next;
    const { rows } = await this.db.query(`
      update channel_items set item = $3, due = $4, revision = revision + 1,
        claimed_by = case when $5::boolean is null then claimed_by when $5 then $6 end,
        claimed_until = case when $5::boolean is null then claimed_until when $5 then now() + $7 * interval '1 millisecond' end
      where id = $1 and revision = $2 returning revision`, [item.id, revision, JSON.stringify(stored), due, claim ?? null, this.options.node, CLAIM_MS]);
    if (!rows[0]) throw new PreconditionFailed(`channel item ${item.id}`);
    return { item: next, revision: rows[0].revision };
  }

  /** Drop a finished item, unless another node retook it since `current` was read. */
  private async finish({ item, revision }: Held) {
    await this.db.query("delete from channel_items where id = $1 and revision = $2", [item.id, revision]);
  }

  /** Release a claimed item after an unexpected error, to be retried later. */
  private async failed(item: Item, error: unknown) {
    console.error(JSON.stringify({ type: "channel_item_failed", item: item.id, state: item.state, error: errorText(error) }));
    const row = (await this.db.query("select item, due, revision, claimed_by from channel_items where id = $1", [item.id]).catch(() => undefined))?.rows[0];
    if (!row || row.claimed_by !== this.options.node) return;
    const current = held(row);
    const attempts = (current.item.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) return this.finish(current).catch(() => {});
    await this.save(current, { attempts, due: Date.now() + this.retryDelay(attempts - 1) }, false).catch(() => {});
  }

  private retryDelay(attempts: number) { return Math.min(10 * 60_000, (this.options.retryBaseMs ?? 2_000) * 2 ** attempts); }

  private async advance(current: Held): Promise<void> {
    const channel = await this.read(current.item.channel);
    if (!channel) return this.finish(current);
    if (current.item.state === "received") return this.receive(channel, current);
    if (current.item.state === "submitted") return this.recheck(channel, current);
    return this.deliver(channel, current);
  }

  private async receive(channel: Channel, current: Held) {
    const item = current.item;
    const inbound = item.inbound!;
    const reply = (text: string) => this.save(current, { state: "sending", text, sent: 0, attempts: 0 }).then(next => this.deliver(channel, next));
    if (inbound.command === "start") return reply(channel.greeting ?? DEFAULT_GREETING);
    const minute = Math.floor(Date.now() / 60_000);
    const recent = await this.count(channel.id, `m${minute}/${sha(inbound.sender.id).slice(0, 16)}`);
    // Only the first message over a limit is told why; the rest are dropped quietly.
    if (recent > channel.limits.perSenderPerMinute) return recent === channel.limits.perSenderPerMinute + 1 ? reply("You're sending messages too quickly. Please wait a minute and try again.") : this.finish(current);
    const today = await this.count(channel.id, `d${new Date().toISOString().slice(0, 10)}/turns`);
    if (today > channel.limits.turnsPerDay) return today === channel.limits.turnsPerDay + 1 ? reply("This assistant has reached its limit for today. Please try again tomorrow.") : this.finish(current);
    const { credentials } = this.secrets(channel);
    void this.provider(channel.type).typing?.(credentials, item.conversationId).catch(() => {});
    const agent = await this.agentFor(channel, item.conversationId, inbound.sender);
    // A reply to the question the agent waits on answers it; anything else is a new message, which supersedes it.
    if (await this.answerInput(channel, agent, inbound)) return this.finish(current);
    const prompt = this.prompt(channel, inbound, await this.attach(channel, credentials, agent, item.id, inbound.files ?? []));
    // Submitted before submitting: the turn may end (and its reply be settled) before submit returns.
    const next = await this.save(current, { state: "submitted", agent, prompt, due: Date.now() + RECHECK_MS }, false);
    // Channels run unattended: a turn goes ahead without the application, whose calls fail as not connected.
    try { await this.options.submit(agent, channel.tenant, { id: item.id, method: "prompt", params: { ...prompt, allowDisconnected: true } }); }
    catch (error) {
      console.error(JSON.stringify({ type: "channel_submit_failed", item: item.id, error: errorText(error) }));
      await this.save(next, { due: Date.now() + this.retryDelay(0) }).catch(() => {});
    }
  }

  /**
   * Stream a message's attachments into the agent's workspace, for request `requestId`. One that
   * is too large or fails to download is left out, with a note for the agent saying so. A retry
   * (another node retaking the item) saves the same paths again.
   */
  private async attach(channel: Channel, credentials: Credentials, agent: string, requestId: string, inbound: InboundFile[]) {
    const provider = this.provider(channel.type);
    const files: { path: string }[] = [], notes: string[] = [], names = new Set<string>();
    let total = 0;
    for (const [index, file] of inbound.entries()) {
      const limit = Math.min(CHANNEL_FILE_LIMITS.fileBytes, provider.maxDownloadBytes ?? Infinity, CHANNEL_FILE_LIMITS.messageBytes - total);
      if (index >= CHANNEL_FILE_LIMITS.files || !this.options.files) { notes.push(`(file ${file.name} not attached)`); continue; }
      if ((file.size ?? 0) > limit) { notes.push(`(file ${file.name} too large, not attached)`); continue; }
      // Two attachments of one name become name, name-2, ...
      let name = file.name;
      for (let n = 2; names.has(name); n++) name = file.name.replace(/(\.[^.]*)?$/, extension => `-${n}${extension}`);
      names.add(name);
      let size = 0;
      try {
        const { body, contentType } = await provider.download(credentials, file);
        const counted = async function* () {
          for await (const chunk of body) {
            if ((size += chunk.length) > limit) throw new Error("too large");
            yield chunk;
          }
        };
        files.push({ path: (await this.options.files.upload(agent, channel.tenant, requestId, name, counted(), file.contentType ?? contentType)).path });
        total += size;
      } catch (error) {
        console.error(JSON.stringify({ type: "channel_attachment_failed", channel: channel.id, request: requestId, error: errorText(error) }));
        notes.push(size > limit ? `(file ${file.name} too large, not attached)` : `(file ${file.name} could not be downloaded, not attached)`);
      }
    }
    return { files, notes };
  }

  /** The message, and who sent it: the runtime shows the model the sender apart from what they wrote. */
  private prompt(channel: Channel, inbound: Inbound, { files, notes }: { files: { path: string }[]; notes: string[] }) {
    const { id, name, username } = inbound.sender;
    const from = { id: `${channel.type}:${id}`, ...(name ? { name: name.slice(0, 200) } : {}), ...(username ? { username: username.slice(0, 200) } : {}) };
    const text = [inbound.text, ...notes].filter(Boolean).join("\n") || (files.length === 1 ? "(sent a file)" : files.length ? `(sent ${files.length} files)` : "");
    return { text, from, ...(files.length ? { files } : {}) };
  }

  /**
   * Answer the input the conversation's agent waits on (its oldest) with this message, when the
   * message is an answer to it (see `answerOf`) from someone allowed to answer. The next waiting
   * input, if any, is asked right away. False when the message is not an answer.
   */
  private async answerInput(channel: Channel, agent: string, inbound: Inbound): Promise<boolean> {
    const inputs = this.options.inputs;
    const input = inputs && !inbound.files?.length ? (await inputs.pending(agent))[0] : undefined;
    const answer = input && answerOf(input, inbound.text);
    if (!input || !answer) return false;
    const { id, name, username } = inbound.sender;
    try { await inputs!.answer(agent, channel.tenant, input.id, { ...answer, from: { id: `${channel.type}:${id}`, ...(name ? { name } : {}), ...(username ? { username } : {}) } }); }
    catch (error) {
      // Not theirs to answer (403), or settled meanwhile (409): the message is a new one.
      if ([403, 409].includes((error as { status?: number }).status ?? 0)) return false;
      throw error;
    }
    const next = (await inputs!.pending(agent)).find(other => other.requestId === input.requestId);
    const binding = await this.binding(agent);
    if (next && binding) await this.enqueue({ id: agent, tenant: channel.tenant }, binding, `ask_${next.id}`, askText(next));
    return true;
  }

  /** A submitted message whose turn end this runtime did not see: ask again (idempotently) how it went. */
  private async recheck(channel: Channel, current: Held) {
    const item = current.item;
    let record: RequestRecord;
    try { record = await this.options.submit(item.agent!, channel.tenant, { id: item.id, method: "prompt", params: { ...item.prompt!, allowDisconnected: true } }); }
    catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 410) return this.finish(current);
      throw error;
    }
    if (record.state !== "completed") { await this.save(current, { due: Date.now() + RECHECK_MS }, false); return; }
    const reply = replyOf(record);
    if (!reply.text && !reply.files.length) return this.finish(current);
    await this.deliver(channel, await this.save(current, { state: "sending", ...reply, sent: 0, attempts: 0 }));
  }

  private async deliver(channel: Channel, current: Held) {
    const provider = this.provider(channel.type);
    const { credentials } = this.secrets(channel);
    const item = current.item;
    const steps = [
      ...chunks(item.text ?? "", provider.maxMessageLength).map(part => () => provider.send(credentials, item.conversationId, part)),
      ...(item.files ?? []).map(file => () => this.sendFile(provider, credentials, item, file)),
    ];
    for (let index = item.sent ?? 0; index < steps.length; index++) {
      try { await steps[index](); }
      catch (error) {
        const attempts = (current.item.attempts ?? 0) + 1;
        const permanent = error instanceof SendError && error.permanent;
        console.error(JSON.stringify({ type: "channel_send_failed", item: current.item.id, attempts, permanent, error: errorText(error) }));
        if (permanent || attempts >= MAX_ATTEMPTS) return this.finish(current);
        const delay = Math.max(this.retryDelay(attempts - 1), error instanceof SendError ? error.retryAfterMs ?? 0 : 0);
        await this.save(current, { attempts, due: Date.now() + delay }, false);
        return;
      }
      // Progress is durable per part, so a retry resumes after the last part sent.
      current = await this.save(current, { sent: index + 1 }, true);
    }
    await this.finish(current);
  }

  /** Send a file, or a link to it when the service will not take one its size. */
  private async sendFile(provider: ChannelProvider, credentials: Credentials, item: Item, file: Presented) {
    const files = this.options.files;
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    const caption = file.caption?.slice(0, 1000);
    if (files && file.size <= provider.maxFileBytes) {
      const blob = async () => {
        const parts: Uint8Array[] = [];
        for await (const part of files.read(item.tenant, file)) parts.push(part);
        return new Blob(parts as BlobPart[], { type: file.contentType });
      };
      return provider.sendFile(credentials, item.conversationId, { name, contentType: file.contentType, size: file.size, blob }, caption);
    }
    const link = files && item.agent ? await files.link(item.agent, item.tenant, file.path).catch(() => undefined) : undefined;
    const text = link ? `${name} (${sizeText(file.size)}, too large to send here; the link works for 24 hours): ${link}` : `(${name} could not be sent)`;
    await provider.send(credentials, item.conversationId, caption ? `${caption}\n${text}` : text);
  }

  /**
   * Queue an agent's message to its conversation and try to send it now. Queued under
   * the agent's claim, so a node that lost the agent mid-turn sends nothing more for it.
   */
  private async enqueue(agent: AgentRef, binding: Binding, id: string, text: string, files: Presented[] = []) {
    const now = Date.now();
    const created = await underClaim(this.db, agent.claim, sql => this.insert(sql, {
      id, channel: binding.channel, tenant: binding.tenant, conversationId: binding.conversationId, createdAt: now,
      state: "sending", agent: agent.id, text, ...(files.length ? { files } : {}), sent: 0, attempts: 0, due: now,
    }));
    if (!created) return;
    const channel = await this.read(binding.channel);
    if (!channel) return this.finish(created);
    await this.deliver(channel, created).catch(error => this.failed(created.item, error));
  }

  /** Count one event in a window, across nodes; returns the new count. */
  private async count(channel: string, window: string): Promise<number> {
    const { rows } = await this.db.query(`
      insert into channel_counts (channel, window_key, count) values ($1, $2, 1)
      on conflict (channel, window_key) do update set count = channel_counts.count + 1 returning count`, [channel, window]);
    return rows[0].count;
  }

  /** The conversation's agent, created on first contact (and again if it expired or was deleted). */
  private async agentFor(channel: Channel, conversationId: string, sender: Sender) {
    const stored = (await this.db.query("select agent, generation from channel_conversations where channel = $1 and conversation = $2", [channel.id, conversationId])).rows[0] as { agent: string; generation: number } | undefined;
    if (stored && await this.options.live(stored.agent, channel.tenant)) return stored.agent;
    const generation = stored ? stored.generation + 1 : 0;
    const label = sender.username ? `@${sender.username}` : sender.name ?? sender.id;
    const params = {
      definition: channel.definition,
      name: `${this.provider(channel.type).label}: ${label}`.slice(0, 120), type: "channel",
      // A conversation outlives any session TTL: its agent lives until deleted (DELETE /v1/agents/:id).
      ttlSeconds: null,
    };
    const key = `${channel.type}-${channel.id}-${conversationId}${generation ? `-${generation}` : ""}`;
    // Bound first: the agent lists its tools (send_message among them) as it starts.
    const id = this.options.agentId(channel.tenant, key);
    const binding: Binding = { channel: channel.id, tenant: channel.tenant, conversationId };
    await this.db.query(`
      insert into channel_agents (agent, channel, tenant, conversation) values ($1, $2, $3, $4)
      on conflict (agent) do update set channel = excluded.channel, tenant = excluded.tenant, conversation = excluded.conversation`, [id, channel.id, channel.tenant, conversationId]);
    this.bindings.set(id, Promise.resolve(binding));
    const created = await this.options.createAgent(channel.tenant, params, key);
    await this.db.query(`
      insert into channel_conversations (channel, conversation, agent, generation) values ($1, $2, $3, $4)
      on conflict (channel, conversation) do update set agent = excluded.agent, generation = excluded.generation`, [channel.id, conversationId, created.id, generation]);
    return created.id;
  }

  private binding(agent: string) {
    let binding = this.bindings.get(agent);
    if (!binding) {
      if (this.bindings.size > 10_000) this.bindings.clear();
      binding = this.db.query("select channel, tenant, conversation from channel_agents where agent = $1", [agent])
        .then(({ rows }) => rows[0] && { channel: rows[0].channel, tenant: rows[0].tenant, conversationId: rows[0].conversation });
      binding.catch(() => this.bindings.delete(agent));
      this.bindings.set(agent, binding);
    }
    return binding;
  }

  // Agent hooks -----------------------------------------------------------------

  readonly hooks: SessionHooks = {
    runStarted: (agent, record) => {
      if (record.method !== "prompt" && record.method !== "resume") return;
      void this.binding(agent.id).then(async binding => {
        const channel = binding && await this.read(binding.channel);
        if (!binding || !channel || this.typing.has(agent.id)) return;
        const provider = this.provider(channel.type);
        if (!provider.typing) return;
        const { credentials } = this.secrets(channel);
        const show = () => void provider.typing!(credentials, binding.conversationId).catch(() => {});
        // The service clears the indicator after a few seconds; keep it up while the turn runs.
        const timer = setInterval(show, provider.typingMs ?? TYPING_MS);
        timer.unref();
        this.typing.set(agent.id, timer);
        setTimeout(() => this.stopTyping(agent.id, timer), 10 * 60_000).unref();
        show();
      }).catch(() => {});
    },
    runEnded: (agent, record) => {
      this.stopTyping(agent.id);
      if (record.method !== "prompt" && record.method !== "resume") return;
      void this.settle(agent, record).catch(error => console.error(JSON.stringify({ type: "channel_reply_failed", agent: agent.id, request: record.id, error: errorText(error) })));
    },
    // A channel's agents get send_message, for updates before the final reply.
    server: async agent => {
      const binding = await this.binding(agent.id);
      return binding && valueServer([SEND_MESSAGE], async ({ args }) => {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        const paths = Array.isArray(args.files) ? args.files.map(String) : [];
        if (!text && !paths.length) throw new Error("send_message needs text or files");
        const files = this.options.files;
        if (paths.length && !files) throw new Error("This runtime cannot send files");
        // Each must be a file in the agent's mounts; its reference pins the version sent.
        const refs = await Promise.all(paths.map(path => files!.ref(agent.id, agent.tenant, path)));
        await this.enqueue(agent, binding, `msg_${randomUUID().replaceAll("-", "")}`, text, refs);
        return { sent: true };
      });
    },
    origin: async (agent, requestId) => {
      const binding = await this.binding(agent.id);
      if (!binding) return undefined;
      const channel = await this.read(binding.channel);
      const item = requestId?.startsWith("in_") ? (await this.db.query("select item from channel_items where id = $1", [requestId])).rows[0]?.item as Item | undefined : undefined;
      const sender = item?.agent === agent.id ? item.inbound?.sender : undefined;
      return { channel: { id: binding.channel, type: channel?.type }, conversationId: binding.conversationId, ...(sender ? { sender } : {}) };
    },
  };

  private stopTyping(agent: string, only?: ReturnType<typeof setInterval>) {
    const timer = this.typing.get(agent);
    if (!timer || (only && timer !== only)) return;
    clearInterval(timer);
    this.typing.delete(agent);
  }

  /** A channel agent's turn ended: its reply goes to the conversation, and the first input it waits on, if any. */
  private async settle(agent: AgentRef, record: RequestRecord) {
    const binding = await this.binding(agent.id);
    if (!binding) return;
    const reply = replyOf(record);
    const waiting = (record.outcome?.result as { inputs?: Input[] } | undefined)?.inputs?.[0];
    if (waiting) reply.text = [reply.text, askText(waiting)].filter(Boolean).join("\n\n");
    const empty = !reply.text && !reply.files.length;
    if (!record.id.startsWith("in_")) {
      // Turns not started by a message (schedules, the API) reply to the conversation too.
      if (!empty) await this.enqueue(agent, binding, `out_${sha(`${agent.id}:${record.id}`).slice(0, 40)}`, reply.text, reply.files);
      return;
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const row = (await this.db.query("select item, due, revision from channel_items where id = $1", [record.id])).rows[0];
      const stored = row && held(row);
      if (!stored || stored.item.state !== "submitted" || stored.item.agent !== agent.id) return;
      if (empty) return this.finish(stored);
      let next: Held;
      try { next = await this.save(stored, { state: "sending", ...reply, sent: 0, attempts: 0, due: Date.now() }, true); }
      catch (error) { if (error instanceof PreconditionFailed) continue; throw error; }
      const channel = await this.read(binding.channel);
      if (!channel) return this.finish(next);
      return this.deliver(channel, next).catch(error => this.failed(next.item, error));
    }
  }
}

/**
 * An input as a message: a question's options numbered, an approval as the runtime's card of the
 * call, a URL step with its address and site, and a confirmation or one-field form.
 */
export function askText(input: Input): string {
  if (input.kind === "question") {
    const questions = input.detail.questions as { question: string; options: { label: string; description?: string }[]; multiSelect: boolean; allowOther: boolean }[];
    return [
      ...questions.map(question => [
        question.question,
        ...question.options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`),
        question.multiSelect ? "Reply with one or more, separated by commas." : "", question.allowOther ? "Or reply in your own words." : "",
      ].filter(Boolean).join("\n")),
      ...questions.length > 1 ? ["Reply with one line per question, in order."] : [],
    ].join("\n\n");
  }
  if (input.kind === "approval") {
    return [`Approve this action? ${input.detail.tool} (${input.detail.source}) with ${input.detail.arguments}`, ...input.detail.reason ? [`The tool says: ${input.detail.reason}`] : [], "Reply approve or deny."].join("\n");
  }
  if (input.kind === "url") return `${input.message}\n${input.detail.url}\n(on ${new URL(input.detail.url).hostname})\nReply done when you have finished.`;
  const fields = Object.keys(input.detail.requestedSchema?.properties ?? {});
  if (!fields.length) return `${input.message}\nReply yes or no.`;
  return fields.length === 1 ? `${input.message}\nReply with the ${fields[0]}.` : `${input.message}\n(This needs a form; answer it in the application.)`;
}

/**
 * A message as the answer to an input, or undefined when it is not one: an option's number or label
 * (or free text, where allowed) for each question; exactly approve/yes or deny/no for an approval
 * or a confirmation; done for a URL step; the value of a one-field form. Anything else is a new message.
 */
export function answerOf(input: Input, text: string): { action: "accept" | "decline"; content?: unknown } | undefined {
  const said = text.trim().replace(/[.!]+$/, "").toLowerCase();
  const fields = Object.entries((input.detail.requestedSchema?.properties ?? {}) as Record<string, { type?: string }>);
  if (input.kind === "approval" || (input.kind === "form" && !fields.length)) {
    if (["approve", "approved", "yes", "y"].includes(said)) return input.kind === "form" ? { action: "accept", content: {} } : { action: "accept" };
    return ["deny", "denied", "no", "n"].includes(said) ? { action: "decline" } : undefined;
  }
  if (input.kind === "url") return said === "done" ? { action: "accept" } : undefined;
  if (input.kind === "form") {
    if (fields.length !== 1) return undefined;
    const [name, field] = fields[0];
    const value = field.type === "number" || field.type === "integer" ? Number(text.trim()) : field.type === "boolean" ? (["yes", "true"].includes(said) ? true : ["no", "false"].includes(said) ? false : undefined) : text.trim();
    return value === undefined || Number.isNaN(value) || value === "" ? undefined : { action: "accept", content: { [name]: value } };
  }
  const questions = input.detail.questions as { question: string; options: { label: string }[]; multiSelect: boolean; allowOther: boolean }[];
  const lines = questions.length === 1 ? [text.trim()] : text.trim().split(/\n+/).map(line => line.trim());
  if (lines.length !== questions.length) return undefined;
  const answers: Record<string, string | string[]> = {};
  for (const [index, question] of questions.entries()) {
    const choose = (part: string) => {
      const number = /^\d+$/.test(part) ? question.options[Number(part) - 1]?.label : undefined;
      return number ?? question.options.find(option => option.label.toLowerCase() === part.toLowerCase())?.label;
    };
    const parts = question.multiSelect ? lines[index].split(",").map(part => part.trim()).filter(Boolean) : [lines[index]];
    const chosen = parts.map(choose);
    if (chosen.every(Boolean)) answers[question.question] = question.multiSelect ? chosen as string[] : chosen[0]!;
    else if (question.allowOther && lines[index]) answers[question.question] = question.multiSelect ? [lines[index]] : lines[index];
    else return undefined;
  }
  return { action: "accept", content: { answers } };
}

/** What a finished prompt says back: the final answer and the files it presented, or an apology when the turn failed. */
function replyOf(record: RequestRecord): { text: string; files: Presented[] } {
  const outcome = record.outcome;
  const result = outcome?.result as { reply?: string; error?: string | null; presented?: unknown[] } | undefined;
  if (!outcome || outcome.error !== undefined || result?.error) return { text: FAILED_REPLY, files: [] };
  const files = (Array.isArray(result?.presented) ? result.presented : []).filter(validFileRef) as Presented[];
  return { text: result?.reply ?? "", files };
}
