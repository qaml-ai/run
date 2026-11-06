import type { Sql, Transaction } from "../host.ts";
import { HttpError } from "../http-error.ts";
import { fetchWithoutRedirects } from "../no-redirect.ts";
import { DECISION_MODEL } from "../decision-questions.ts";
import { FILTERED_DAYS, FILTER_QUESTION, FILTER_TIMEOUT_MS, channelFilter, filterState, type ChannelFilter, type Verdict, type VerdictReason } from "./filter.ts";
import { base64UrlText, randomHex, sha256Hex, textBase64Url } from "./crypto.ts";

/**
 * Channels let people talk to agents through messaging services. Each external
 * conversation gets its own agent, created on first contact from the channel's
 * definition; a message becomes a prompt, and the turn's reply goes back the same way.
 * Messages arrive by webhook (Telegram, Slack, GitHub, email, any service's webhooks).
 * Everything is in Postgres, so any node (or Worker) can take a webhook or send a reply:
 *
 *   channels                the channel: its definition, access, limits, sealed credentials
 *   channel_conversations   the agent answering one external conversation
 *   channel_agents          the conversation an agent answers
 *   channel_items           live work: an inbound message until its reply is sent, or an outbound message
 *   channel_seen            inbound messages already recorded, so provider retries are dropped; a channel filter's verdict on each
 *   channel_counts          rate-limit and daily-turn counters
 *
 * Items move received → submitted → sending by writes conditional on their
 * revision, and whoever holds an item's claim is the only node advancing it, so a
 * reply is sent once. A message a channel's filter leaves out stays as `filtered`,
 * not due until it expires, until someone delivers it (back to received).
 *
 * Attachments are streamed into the agent's workspace and the prompt refers to them by
 * path; files the agent presents (or sends with send_message) go out after the reply's
 * text, each a step of the item's durable progress, so a retry resumes after the last one sent.
 *
 * This class is shared by the Node runtime (src/channels.ts) and the Workers backend: hosts
 * supply the database, sealing, agents and files (`ChannelsHost`), and own their timers.
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
  /** A reply in a thread: a filter does not ask about it once the thread has an agent, so a customer's "yes please" is not judged alone. */
  followUp?: boolean;
  /** What to call the conversation's agent when it is made (a pull request's title), instead of the sender. */
  title?: string;
  /** Vouched for by the provider under the channel's settings (a repository's member), so let in without the allowlist. */
  trusted?: boolean;
  /**
   * Nothing proves the sender (mail a trusted forwarder passed on): the model sees `from.id` as
   * `<type>:unverified:<id>`, and the message never answers an input the agent waits on.
   */
  unverified?: boolean;
  /**
   * Wait `debounceMs` before starting on this message; another with the same key arriving meanwhile
   * takes its place and restarts the wait, so a burst (pushes in quick succession) makes one turn.
   */
  coalesce?: { key: string; debounceMs: number };
}
/**
 * An attachment: `id` is the provider's reference to fetch it by; `size` and `contentType` as the service declares them.
 * A file that came inside the delivery itself carries its bytes as `content` (base64) and is saved without a download.
 */
export interface InboundFile { id: string; name: string; size?: number; contentType?: string; content?: string }
/** A file going out, read from its volume (a chunk at a time) when it is sent: at most the service's `maxFileBytes`. */
export interface OutboundFile { name: string; contentType: string; size: number; blob(): Promise<Blob> }
export type Credentials = Record<string, string>;
/** Non-secret, provider-specific configuration of a channel (which events start a turn, templates), as the provider validated it. */
export type ChannelSettings = Record<string, unknown>;
/** What a provider knows about the channel a delivery is for, besides the delivery itself. */
export interface ParseContext { headers: Headers; account: Record<string, string>; settings: ChannelSettings }
/** An attachment's bytes as a provider fetched them. */
export interface Download { body: AsyncIterable<Uint8Array>; contentType?: string }
/**
 * What the core needs from a messaging service; everything provider-specific lives behind it.
 * A service delivers messages to a webhook (`verify` and `parse`), or to a shared inbound address (`Channels.inbound`).
 */
export interface ChannelProvider {
  readonly label: string;
  readonly maxMessageLength: number;
  /** Validate credentials and, where the service allows it, point its webhook at `webhook.url`. */
  setup(credentials: Credentials, webhook: { url: string; secret: string }): Promise<{ account: Record<string, string>; masked: Record<string, string> }>;
  teardown(credentials: Credentials): Promise<void>;
  /** Whether a webhook delivery is genuine, proven with the channel's random secret or a credential the service signs with. */
  verify?(headers: Headers, body: string, secret: string, credentials: Credentials, settings: ChannelSettings): boolean | Promise<boolean>;
  /** What to answer a verified delivery that is a handshake (a URL-verification challenge) rather than a message. */
  handshake?(body: unknown): object | undefined;
  /** An inbound message, or undefined for updates the channel ignores. */
  parse?(body: unknown, context: ParseContext): Inbound | undefined;
  /** The largest webhook body the service sends (default 1 MB). */
  readonly maxBodyBytes?: number;
  /** Validate a channel's settings (`current` on an update, merged over by `input`); a provider without it takes none. */
  settings?(input: ChannelSettings | undefined, current?: ChannelSettings, channel?: { id: string }): ChannelSettings;
  /** False for a service whose channels need no credentials of their own (the runtime's email domain). */
  readonly needsCredentials?: boolean;
  /** Whether an allowlist entry admits a sender, for services whose entries are not ids or @usernames (whole email domains). */
  allows?(entry: string, sender: Sender): boolean;
  /** Access and limits a new channel of this type starts with, before the ones it is created with. */
  readonly defaults?: { access?: Partial<Channel["access"]>; limits?: Partial<Channel["limits"]> };
  /** An attachment's bytes, from the service's own file host only. */
  download(credentials: Credentials, file: InboundFile): Promise<Download>;
  /** The largest attachment a bot may download, when the service caps it below CHANNEL_FILE_LIMITS.fileBytes. */
  readonly maxDownloadBytes?: number;
  send(credentials: Credentials, conversationId: string, text: string): Promise<void>;
  sendFile(credentials: Credentials, conversationId: string, file: OutboundFile, caption?: string): Promise<void>;
  /** The largest file the service takes from a bot; larger ones are sent as a link. */
  readonly maxFileBytes: number;
  /** Whether turns' replies (and send_message) go to the conversation; false leaves the agent to act through its tools. Default true. */
  replies?(settings: ChannelSettings): boolean;
  /** Show that a reply is coming; a service without an indicator leaves it out. */
  typing?(credentials: Credentials, conversationId: string): Promise<void>;
  /** How often the indicator is refreshed while a turn runs (default 4 s). */
  readonly typingMs?: number;
}
/** A failed send; permanent failures (blocked bot, unknown chat) are not retried. */
export class SendError extends Error {
  permanent: boolean; retryAfterMs?: number;
  constructor(message: string, permanent: boolean, retryAfterMs?: number) {
    super(message); this.permanent = permanent; this.retryAfterMs = retryAfterMs;
  }
}

/** Sealed credentials, as the host's key sealing stores them. */
export type Sealed = { iv: string; tag: string; ciphertext: string };
export interface Channel {
  id: string; tenant: string; type: string; name: string;
  /** Where the service delivers messages; channels that receive at a shared address (email) have none. */
  webhookUrl?: string;
  /** What each conversation's agent is made from. */
  definition: string;
  /** Senders by id or @username; `public` lets anyone in. */
  access: { public: boolean; allow: string[] };
  limits: { perSenderPerMinute: number; turnsPerDay: number };
  greeting?: string;
  /** Provider-specific configuration (see ChannelProvider.settings). */
  settings?: ChannelSettings;
  /** The question each message must pass before it starts a turn. */
  filter?: ChannelFilter;
  account: Record<string, string>;
  masked: Record<string, string>;
  sealed: Sealed;
  createdAt: number; updatedAt: number;
}
export type ChannelInput = Partial<Pick<Channel, "name" | "definition" | "greeting" | "settings">> & {
  type?: string; credentials?: Credentials;
  access?: Partial<Channel["access"]>; limits?: Partial<Channel["limits"]>;
  /** Null removes it. */
  filter?: unknown;
};
export type Binding = { channel: string; tenant: string; conversationId: string };
/** A file for the conversation, as `present_file` or send_message gave it: the host's file reference, with these fields. */
export type Presented = { type: "file"; path: string; size: number; contentType: string; caption?: string; [field: string]: unknown };
export type Item = {
  id: string; channel: string; tenant: string; conversationId: string; createdAt: number;
  state: "received" | "submitted" | "sending" | "filtered";
  /** Not before this time: the next retry or re-check. */
  due: number;
  inbound?: Inbound;
  /** The channel filter's answer, once asked: a retake does not ask again. */
  verdict?: Verdict;
  agent?: string; prompt?: { text: string; from?: { id: string; name?: string; username?: string }; files?: { path: string }[] };
  /** What to send: the text's parts, then each file; `sent` counts the steps done. */
  text?: string; files?: Presented[]; sent?: number; attempts?: number;
};
/** An item as last written; the next write is conditional on its revision. */
export type Held = { item: Item; revision: number };
/** A run as the host's agents record it: enough to know its reply. */
export interface ChannelRun { id: string; method: string; state: string; outcome?: { result?: unknown; error?: unknown } }
/** An input an agent waits on, as the host's inputs list it. */
export interface PendingInput { id: string; requestId?: string; kind: string; message: string; detail: Record<string, any> }
/** An agent, as the host's hooks name it; `claim` is the host's own (a Node node's hold on the agent). */
export interface ChannelAgent { id: string; tenant: string; claim?: unknown }

/** A write conditional on an item's revision lost: someone else changed it. */
export class ItemChanged extends Error {
  constructor(id: string) { super(`Conditional write lost for channel item ${id}: another writer changed it`); this.name = "PreconditionFailed"; }
}

/** send_message's parameters: the same tool on every host. */
export const SEND_MESSAGE_TOOL = {
  name: "send_message",
  description: "Send a message to the person you are talking with right away, before your final reply: for progress updates during long work, or files. Your final reply is sent automatically; do not repeat it here.",
  parameters: { type: "object", properties: {
    text: { type: "string", maxLength: 16_000 },
    files: { type: "array", maxItems: 10, items: { type: "string" }, description: "Paths of files in your mounts to send, e.g. /workspace/report.pdf" },
  }, additionalProperties: false },
} as const;
/**
 * Attachments a message brings in, saved to the agent's workspace: at most `files` of them,
 * each at most `fileBytes` and `messageBytes` in all, each downloaded within `downloadMs`.
 */
export const CHANNEL_FILE_LIMITS = Object.freeze({ files: 10, fileBytes: 25 * 1024 * 1024, messageBytes: 100 * 1024 * 1024, downloadMs: 60_000 });
export const DEFAULT_LIMITS = { perSenderPerMinute: 10, turnsPerDay: 1_000 };
const DEFAULT_GREETING = "Hi! Send me a message to get started.";
const FAILED_REPLY = "Sorry, something went wrong while answering. Please try again.";
/** A claim older than this is assumed abandoned by a crashed node and may be retaken. */
export const CLAIM_MS = 60_000;
/** How often a submitted message's turn is checked when its end was not observed (a crash). */
export const RECHECK_MS = 60_000;
const CLAIM_BATCH = 100;
/** Provider retries come within minutes; seen markers and counters are pruned after this. */
const SEEN_DAYS = 7;
const PRUNE_EVERY_MS = 60 * 60_000;
const MAX_ATTEMPTS = 8;
const MAX_REPLY = 32_000;
/** How much of a filtered message's text its event shows. */
const EVENT_TEXT_CHARS = 4_000;
export const TYPING_MS = 4_000;
/** How long a turn's typing indicator is kept up at most. */
export const TYPING_MAX_MS = 10 * 60_000;
/**
 * Channel types this runtime no longer serves. Their stored channels stay as they are (a later migration may drop
 * them): listed as disabled, never connected or answered, and deletable. Creating or changing one is refused.
 */
export const RETIRED_CHANNEL_TYPES: ReadonlySet<string> = new Set(["discord", "discord-managed"]);
export const RETIRED_CHANNEL_MESSAGE = "Discord channels are no longer supported: Discord bots live in camelBots (https://bots.camelai.com)";

/** Fetch an attachment from a service's file host: never redirected (a token may go with it), within a time limit. */
export async function fetchFile(fetcher: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<Download> {
  const response = await fetchWithoutRedirects(fetcher, url, { headers, signal: AbortSignal.timeout(CHANNEL_FILE_LIMITS.downloadMs) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  return { body: response.body as unknown as AsyncIterable<Uint8Array>, contentType: response.headers.get("content-type")?.split(";")[0] };
}
/** A file's size for people. */
export const sizeText = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

const sha = sha256Hex;
export const seenKey = (messageId: string) => sha(messageId).slice(0, 40);
/** An inbound message's item id, which is also its run's id. */
export const inboundItemId = (channel: string, messageId: string) => `in_${sha(`${channel}:${messageId}`).slice(0, 40)}`;
const held = (row: any): Held => ({ item: { ...row.item, due: Number(row.due) }, revision: row.revision });
export const validConversation = (value: string) => /^[A-Za-z0-9_.-]{1,64}$/.test(value);
/** The key a conversation's agent is created under: one agent per conversation, a new one for each generation. */
export const conversationAgentKey = (channel: Pick<Channel, "type" | "id">, conversationId: string, generation: number) => {
  const key = `${channel.type}-${channel.id}-${conversationId}${generation ? `-${generation}` : ""}`;
  // A provisioning key is letters, digits, "_" and "-", up to 80: a conversation outside that (Slack's thread "100.0001", a long webhook key) is told apart by a hash.
  return /^[A-Za-z0-9_-]{1,80}$/.test(key) ? key : `${channel.type}-${channel.id}-${sha(key).slice(0, 32)}`;
};
/** A write that broke a unique index on channels (a provider's settings that must be unique, like an email address). */
const taken = (error: unknown): never => {
  if ((error as { code?: string }).code === "23505") throw new HttpError(409, "Another channel already has these settings (is the address taken?)");
  throw error;
};
/** Split text for a service's message limit, at a line or word break when one is near. */
export function chunks(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY)}…` : text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = /[\uD800-\uDBFF]/.test(rest[max - 1]!) ? max - 1 : max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** What a channel's agents need of files: saving attachments into the agent's workspace, and reading what it sends. */
export interface ChannelFiles {
  /** Save an attachment for request `requestId` in the agent's workspace. */
  upload(agent: string, tenant: string, requestId: string, name: string, source: AsyncIterable<Uint8Array>, contentType?: string): Promise<{ path: string }>;
  /** A file in the agent's mounts, as a reference; rejects paths outside them. */
  ref(agent: string, tenant: string, path: string): Promise<Presented>;
  read(tenant: string, ref: Presented): AsyncIterable<Uint8Array>;
  /** A download link to a file in the agent's mounts, lasting as long as links may. */
  link(agent: string, tenant: string, path: string): Promise<string>;
}

/** Everything a host gives the shared channels: its database, keys, agents and files. */
export interface ChannelsHost {
  sql: Sql;
  transaction: Transaction;
  /** Who claims items: a Node node's id, or a Worker isolate's. */
  node: string;
  publicUrl: string;
  providers: Record<string, ChannelProvider>;
  keys: { canStore: boolean; seal(context: string, plaintext: string): Sealed; unseal(context: string, sealed: Sealed): string };
  definitions: {
    read(tenant: string, id: string): Promise<{ id: string; spec: { channel?: string; dataCollection?: unknown } }>;
    create(tenant: string, input: { name: string }, spec: { channel: string }): Promise<{ id: string }>;
    remove(tenant: string, id: string): Promise<unknown>;
  };
  createAgent(tenant: string, params: any, key: string): Promise<{ id: string }>;
  /** The id `createAgent` gives the agent for a key, so the conversation is bound before the agent starts. */
  agentId(tenant: string, key: string): string | Promise<string>;
  /** Whether the agent still exists and is the tenant's. */
  live(agent: string, tenant: string): Promise<boolean>;
  /** Submit a request to an agent wherever it is served. */
  submit(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }): Promise<ChannelRun>;
  /** Files in and out of agents' volumes; without it attachments are noted but not saved, and files are not sent. */
  files?: ChannelFiles;
  /** Whether a run's presented file is one this host can send (Node: a volume FileRef). */
  isFile?(value: unknown): boolean;
  /** Human input an agent waits on: its pending inputs, oldest first, and answering one (as its sender, who must be allowed to). */
  inputs?: {
    pending(agent: string): Promise<PendingInput[]>;
    answer(agent: string, tenant: string, input: string, answer: { action: "accept" | "decline"; content?: unknown; from: { id: string; name?: string; username?: string } }): Promise<unknown>;
  };
  /** Asks channel filters, billed as POST /v1/decisions; without it a channel cannot have one. */
  decisions?: {
    available(tenant: string): Promise<boolean>;
    /** One noul question about one state; resolves with the provider's answer, as `decisionsRequest` gives it. */
    ask(tenant: string, request: { items: { state: unknown; questions: Record<string, unknown> }[]; batch: false; model: string; actor: string; dataCollection?: unknown }, signal: AbortSignal): Promise<{ answers?: Record<string, { type: string; noul?: number }>; model?: string; costUsd?: number; ms?: number } | object>;
  };
  /** Queue an outbound message under the agent's claim (Node), so a node that lost the agent writes nothing; default: as is. */
  underClaim?<T>(agent: ChannelAgent, work: (sql: Sql) => Promise<T>): Promise<T>;
  /** Only while this node's lease is fresh (Node); hosts without leases leave it out. */
  ownership?: { fresh(): boolean; whenFresh(): Promise<void> };
  /** Work that continues after the request that started it is answered (a Worker's waitUntil). Default: left running. */
  background?(work: Promise<unknown>): void;
  /** An item comes due at `due` (a retry, a debounce, a re-check): hosts without a periodic scan schedule one. */
  wake?(due: number): void;
  retryBaseMs?: number;
  /** How long a submitted message waits before its turn is asked about again (default RECHECK_MS). */
  recheckMs?: number;
  /** An error as logs may show it: its class and codes, never its text (which may hold a message's content). */
  safeError(error: unknown): string;
}

export class Channels {
  protected readonly host: ChannelsHost;
  private readonly bindings = new Map<string, Promise<Binding | undefined>>();
  private scanning = false;
  private prunedAt = 0;

  constructor(host: ChannelsHost) {
    this.host = host;
  }

  private background(work: Promise<unknown>) {
    if (this.host.background) this.host.background(work);
  }
  private wakeAt(due: number) { if (this.host.wake && due > Date.now()) this.host.wake(due); }

  // Configuration ---------------------------------------------------------------

  protected provider(type: string) {
    const provider = Object.hasOwn(this.host.providers, type) ? this.host.providers[type] : undefined;
    if (!provider && RETIRED_CHANNEL_TYPES.has(type)) throw new HttpError(400, RETIRED_CHANNEL_MESSAGE, "CHANNEL_TYPE_RETIRED");
    if (!provider) throw new HttpError(400, `Unknown channel type ${type}; supported: ${Object.keys(this.host.providers).join(", ")}`);
    return provider;
  }
  /** Whether this runtime serves the channel's type: a retired type's stored channels are kept but never answered. */
  protected served(channel: Pick<Channel, "type">) { return Object.hasOwn(this.host.providers, channel.type); }
  protected async read(id: string, sql: Sql = this.host.sql) {
    if (!/^ch_[a-f0-9]{20}$/.test(id)) return undefined;
    return (await sql.query("select channel from channels where id = $1", [id])).rows[0]?.channel as Channel | undefined;
  }
  private async owned(tenant: string, id: string, sql?: Sql) {
    const channel = await this.read(id, sql);
    if (!channel || channel.tenant !== tenant) throw new HttpError(404, "Unknown channel");
    return channel;
  }
  protected secrets(channel: Channel): { credentials: Credentials; secret: string } {
    return JSON.parse(this.host.keys.unseal(`channel:${channel.id}`, channel.sealed));
  }
  /** Credentials never leave the runtime: callers see a masked form. A channel of a retired type shows as disabled. */
  view({ sealed: _sealed, masked, ...channel }: Channel) {
    return { ...channel, credentials: masked, ...(RETIRED_CHANNEL_TYPES.has(channel.type) && !this.served(channel) ? { disabled: true } : {}) };
  }

  async list(tenant: string) {
    const { rows } = await this.host.sql.query("select channel from channels where tenant = $1 order by created_at, id", [tenant]);
    return rows.map(row => this.view(row.channel));
  }
  async get(tenant: string, id: string) { return this.view(await this.owned(tenant, id)); }

  async create(tenant: string, input: ChannelInput) {
    const type = input.type ?? "";
    if (RETIRED_CHANNEL_TYPES.has(type) && !Object.hasOwn(this.host.providers, type)) throw new HttpError(400, RETIRED_CHANNEL_MESSAGE, "CHANNEL_TYPE_RETIRED");
    if (!this.host.keys.canStore) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot store channel credentials");
    const provider = this.provider(type);
    if (!input.credentials && provider.needsCredentials !== false) throw new HttpError(400, "A channel needs credentials");
    const credentials = input.credentials ?? {};
    const id = `ch_${randomHex(10)}`;
    const secret = randomHex(32);
    const webhookUrl = `${this.host.publicUrl}/channels/${type}/${id}`;
    const settings = this.settings(provider, input, id);
    const filter = await this.filterInput(tenant, input.filter);
    const { account, masked } = await provider.setup(credentials, { url: webhookUrl, secret });
    const now = Date.now();
    const name = input.name ?? `${provider.label} ${account.username ? `@${account.username}` : id}`;
    const channel: Channel = {
      id, tenant, type, name, ...(provider.verify ? { webhookUrl } : {}),
      definition: await this.definition(tenant, id, name, input), access: { public: false, allow: [], ...provider.defaults?.access, ...settings.access }, limits: { ...DEFAULT_LIMITS, ...provider.defaults?.limits, ...settings.limits },
      ...(settings.greeting ? { greeting: settings.greeting } : {}), ...(settings.settings ? { settings: settings.settings } : {}), ...(filter ? { filter } : {}), account, masked,
      sealed: this.host.keys.seal(`channel:${id}`, JSON.stringify({ credentials, secret })), createdAt: now, updatedAt: now,
    };
    await this.host.sql.query("insert into channels (id, tenant, channel, created_at) values ($1, $2, $3, $4)", [id, tenant, JSON.stringify(channel), now]).catch(taken);
    return this.view(channel);
  }

  async update(tenant: string, id: string, input: ChannelInput) {
    const channel = await this.owned(tenant, id);
    this.provider(channel.type);
    if (input.type !== undefined && input.type !== channel.type) throw new HttpError(400, "A channel's type cannot change");
    const settings = this.settings(this.provider(channel.type), input, id, channel.settings);
    const filter = await this.filterInput(tenant, input.filter);
    const next: Channel = {
      ...channel, ...(input.name !== undefined ? { name: input.name } : {}),
      definition: await this.definition(tenant, id, input.name ?? channel.name, input, channel.definition),
      access: { ...channel.access, ...settings.access }, limits: { ...channel.limits, ...settings.limits },
      ...(settings.greeting !== undefined ? { greeting: settings.greeting } : {}), ...(settings.settings ? { settings: settings.settings } : {}), ...(filter ? { filter } : {}), updatedAt: Date.now(),
    };
    if (input.filter === null) delete next.filter;
    if (input.credentials) {
      const provider = this.provider(channel.type);
      const old = this.secrets(channel).credentials;
      const secret = randomHex(32);
      Object.assign(next, await provider.setup(input.credentials, { url: `${this.host.publicUrl}/channels/${channel.type}/${id}`, secret }));
      next.sealed = this.host.keys.seal(`channel:${id}`, JSON.stringify({ credentials: input.credentials, secret }));
      // A different bot keeps its webhook pointed here otherwise.
      if (next.account.id !== channel.account.id) await provider.teardown(old).catch(() => {});
    }
    await this.host.sql.query("update channels set channel = $2 where id = $1", [id, JSON.stringify(next)]).catch(taken);
    return this.view(next);
  }

  async remove(tenant: string, id: string) {
    const channel = await this.owned(tenant, id);
    const provider = this.served(channel) ? this.host.providers[channel.type] : undefined;
    // A retired type's channel is deleted without its service: there is nothing of it to tear down here.
    if (!provider && !RETIRED_CHANNEL_TYPES.has(channel.type)) this.provider(channel.type);
    try { await provider?.teardown(this.secrets(channel).credentials); }
    catch (error) { console.error(JSON.stringify({ type: "channel_teardown_failed", channel: id, error: this.host.safeError(error) })); }
    // Its queued work (filtered messages too), dedup, verdicts and rate windows, and its email threads' metadata go too: nothing replies
    // through it again. Together, since a retried account deletion only finds channels that still exist.
    await this.host.transaction(async sql => {
      await sql.query("delete from channels where id = $1 and tenant = $2", [id, tenant]);
      for (const table of ["channel_seen", "channel_counts", "email_threads", "email_messages"]) await sql.query(`delete from ${table} where channel = $1`, [id]);
      await sql.query("delete from channel_items where item->>'channel' = $1", [id]);
    });
    // A definition made for the channel goes with it, unless another channel took it up.
    if ((await this.host.definitions.read(tenant, channel.definition).catch(() => undefined))?.spec.channel === id) {
      await this.host.definitions.remove(tenant, channel.definition).catch(() => {});
    }
  }

  /** A filter as given, refused where it could only ever fail: a runtime or an account with no key decisions could use. */
  private async filterInput(tenant: string, value: unknown) {
    if (value === undefined || value === null) return undefined;
    const filter = channelFilter(value);
    if (!await this.host.decisions?.available(tenant)) throw new HttpError(400, "A filter needs decisions, which need an OpenRouter key: add one under Models & keys (PUT /v1/providers/openrouter/key)", "DECISIONS_UNAVAILABLE");
    return filter;
  }

  private settings(provider: ChannelProvider, input: ChannelInput, id: string, current?: ChannelSettings) {
    if (input.settings !== undefined && !provider.settings) throw new HttpError(400, `${provider.label} channels take no settings`);
    const settings = provider.settings && (input.settings !== undefined || !current) ? provider.settings(input.settings, current, { id }) : undefined;
    return { access: input.access, limits: input.limits, greeting: input.greeting, settings };
  }

  /**
   * The definition a channel's agents are made from: the one named, else the one it has,
   * else (a new channel given none) an empty definition of the channel's own.
   */
  private async definition(tenant: string, id: string, name: string, input: ChannelInput, current?: string): Promise<string> {
    if (input.definition !== undefined) return (await this.host.definitions.read(tenant, input.definition)).id;
    return current ?? (await this.host.definitions.create(tenant, { name: name.slice(0, 120) }, { channel: id })).id;
  }

  // Filter activity --------------------------------------------------------------

  /**
   * What a channel's filter said, newest first: a verdict for each message (no content), and for one still waiting to be
   * delivered, the message itself. `before` is the `next` of the page before.
   */
  async events(tenant: string, id: string, options: { limit?: number; outcome?: string; before?: string } = {}) {
    await this.owned(tenant, id);
    const limit = options.limit ?? 50;
    let after: [string, string] | undefined;
    if (options.before) {
      try { after = JSON.parse(base64UrlText(options.before)); } catch { /* said below */ }
      if (!Array.isArray(after) || after.length !== 2 || !after.every(part => typeof part === "string") || Number.isNaN(Date.parse(after[0]))) throw new HttpError(400, "before is the next value of an earlier page");
    }
    const { rows } = await this.host.sql.query(`
      select s.verdict, s.seen_at::text as seen_at, s.message, c.agent, i.item->>'state' as state, i.due,
        i.item->'inbound'->'sender' as sender, i.item->'inbound'->>'title' as title, (i.item->'inbound'->>'unverified')::boolean as unverified,
        left(i.item->'inbound'->>'text', $5) as text,
        (select json_agg(json_build_object('name', f->>'name', 'size', f->'size')) from json_array_elements(i.item->'inbound'->'files') f) as files
      from channel_seen s
      left join channel_items i on i.id = s.verdict->>'item'
      left join channel_conversations c on c.channel = s.channel and c.conversation = s.verdict->>'conversation'
      where s.channel = $1 and s.verdict is not null and ($2::text is null or s.verdict->>'outcome' = $2)
        and ($3::timestamptz is null or (s.seen_at, s.message) < ($3::timestamptz, $4::text))
      order by s.seen_at desc, s.message desc limit $6`, [id, options.outcome ?? null, after?.[0] ?? null, after?.[1] ?? null, EVENT_TEXT_CHARS, limit + 1]);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      events: rows.slice(0, limit).map(row => {
        const { item, conversation, ...verdict } = row.verdict as Verdict;
        const waiting = row.state === "filtered";
        return {
          id: item, conversationId: conversation, ...verdict, ...(row.agent && !waiting ? { agent: row.agent } : {}),
          ...(waiting ? { deliverableUntil: Number(row.due), message: { from: row.sender, ...(row.unverified ? { unverified: true } : {}), ...(row.title ? { title: row.title } : {}), text: row.text ?? "", files: row.files ?? [] } } : {}),
        };
      }),
      ...(last ? { next: textBase64Url(JSON.stringify([last.seen_at, last.message])) } : {}),
    };
  }

  /**
   * Send a filtered message on, as if the filter had passed it. It keeps its id, which is its run's, so delivering it
   * twice starts one run; a second call answers as the first did.
   */
  async deliverEvent(tenant: string, id: string, event: string) {
    await this.owned(tenant, id);
    const row = (await this.host.sql.query("select item, due, revision from channel_items where id = $1 and item->>'channel' = $2", [event, id])).rows[0];
    const current = row ? held(row) : undefined;
    if (current?.item.state !== "filtered") {
      const verdict = (await this.host.sql.query("select verdict from channel_seen where channel = $1 and verdict->>'item' = $2", [id, event])).rows[0]?.verdict as Verdict | undefined;
      if (verdict?.deliveredAt) return { id: event, deliveredAt: verdict.deliveredAt };
      throw verdict ? new HttpError(409, verdict.outcome === "passed" ? "This message passed the filter: it was not held" : "This message's time to be delivered is up") : new HttpError(404, "Unknown event");
    }
    const deliveredAt = Date.now();
    const verdict = { ...current.item.verdict!, deliveredAt };
    let next: Held;
    try {
      next = await this.host.transaction(async sql => {
        await sql.query("update channel_seen set verdict = $3 where channel = $1 and message = $2", [id, seenKey(current.item.inbound!.messageId), JSON.stringify(verdict)]);
        return this.save(current, { verdict, state: "received", due: deliveredAt }, true, sql);
      });
    } catch (error) {
      if (error instanceof ItemChanged) throw new HttpError(409, "This message changed while delivering it: try again");
      throw error;
    }
    this.background(this.advance(next).catch(error => this.failed(next.item, error)));
    return { id: event, deliveredAt };
  }

  // Inbound ---------------------------------------------------------------------

  /**
   * A delivery to a channel's public webhook (`POST /channels/:type/:id`), mounted before any authentication: each
   * request proves itself with the channel's secret. `body` reads the request's text, at most `max` bytes (throws past it).
   */
  async webhook(type: string, id: string, headers: Headers, body: (max: number) => Promise<string>): Promise<{ status: number; json?: object }> {
    const channel = await this.read(id);
    if (!channel || channel.type !== type) return { status: 404 };
    const provider = this.provider(channel.type);
    if (!provider.verify || !provider.parse) return { status: 404 };
    let text: string;
    try { text = await body(provider.maxBodyBytes ?? 1_000_000); } catch { return { status: 413 }; }
    const { credentials, secret } = this.secrets(channel);
    if (!await provider.verify(headers, text, secret, credentials, channel.settings ?? {})) return { status: 401 };
    let payload: unknown, inbound: Inbound | undefined;
    try { payload = JSON.parse(text); } catch { return { status: 400 }; }
    const handshake = provider.handshake?.(payload);
    if (handshake) return { status: 200, json: handshake };
    try { inbound = provider.parse(payload, { headers, account: channel.account, settings: channel.settings ?? {} }); } catch { return { status: 400 }; }
    if (inbound) await this.accept(channel, inbound);
    return { status: 200 };
  }

  /**
   * A message that reached the runtime some other way than the channel's own webhook
   * (a shared inbound address that serves many channels), already verified by
   * whoever received it. False when there is no such channel.
   */
  async inbound(id: string, inbound: Inbound): Promise<boolean> {
    const channel = await this.read(id);
    if (!channel) return false;
    await this.accept(channel, inbound);
    return true;
  }

  /** A channel as stored, with its credentials, for a receiver outside this class (see `inbound`). */
  async lookup(id: string): Promise<{ channel: Channel; credentials: Credentials } | undefined> {
    const channel = await this.read(id);
    return channel && { channel, credentials: this.secrets(channel).credentials };
  }

  /** Record a message and start on it. Anything the channel does not handle, or from someone not allowed, is dropped. */
  private async accept(channel: Channel, inbound: Inbound) {
    if (!this.served(channel)) return;
    if (!validConversation(inbound.conversationId) || !(inbound.trusted || this.allowed(channel, inbound.sender))) {
      console.log(JSON.stringify({ type: "channel_message_rejected", channel: channel.id, messageId: inbound.messageId,
        reason: !validConversation(inbound.conversationId) ? "invalid_conversation" : "access" }));
      return;
    }
    if (inbound.continuation) {
      const known = await this.host.sql.query("select 1 from channel_conversations where channel = $1 and conversation = $2", [channel.id, inbound.conversationId]);
      if (!known.rowCount) return;
    }
    const recorded = await this.record(channel, inbound);
    // A message waiting out its debounce is started by a later scan.
    if (recorded && recorded.item.due <= Date.now()) this.background(this.advance(recorded).catch(error => this.failed(recorded.item, error)));
    else if (recorded) this.wakeAt(recorded.item.due);
  }

  allowed(channel: Pick<Channel, "access" | "type">, sender: Sender) {
    if (channel.access.public) return true;
    const username = sender.username?.toLowerCase();
    const allows = this.provider(channel.type).allows;
    return channel.access.allow.some(entry => {
      if (allows) return allows(entry, sender);
      const normalized = entry.trim().replace(/^@/, "");
      // Ids match exactly (Slack's are upper case); usernames in any case.
      return normalized === sender.id || (!!username && normalized.toLowerCase() === username);
    });
  }

  /** Durably record a message before acknowledging it, claimed by this node; undefined for one already recorded. */
  private record(channel: Channel, inbound: Inbound) {
    const now = Date.now();
    const item: Item = {
      id: inboundItemId(channel.id, inbound.messageId), channel: channel.id, tenant: channel.tenant, conversationId: inbound.conversationId,
      createdAt: now, state: "received", due: now + (inbound.coalesce?.debounceMs ?? 0), inbound,
    };
    // The seen marker and the item commit together, so a retried delivery finds one or the other.
    return this.host.transaction(async sql => {
      const seen = await sql.query("insert into channel_seen (channel, message) values ($1, $2) on conflict do nothing", [channel.id, seenKey(inbound.messageId)]);
      if (!seen.rowCount) return undefined;
      if (!inbound.coalesce) return this.insert(sql, item);
      // One not yet started with the same key takes this message instead (keeping its id), and waits again.
      const { rows } = await sql.query(`
        select id, item, revision from channel_items where item->>'channel' = $1 and item->>'state' = 'received'
          and item->'inbound'->'coalesce'->>'key' = $2 and (claimed_until is null or claimed_until <= now())
        limit 1 for update skip locked`, [channel.id, inbound.coalesce.key]);
      if (!rows[0]) return this.insert(sql, item, false);
      const next: Item = { ...rows[0].item, inbound, due: item.due };
      const { due, ...stored } = next;
      const updated = await sql.query("update channel_items set item = $2, due = $3, revision = revision + 1 where id = $1 returning revision", [rows[0].id, JSON.stringify(stored), due]);
      return { item: next, revision: updated.rows[0].revision } as Held;
    });
  }

  /** Insert an item, claimed by this node to work on at once unless `claimed` is false (it waits for a scan). */
  private async insert(sql: Sql, item: Item, claimed = true): Promise<Held | undefined> {
    const { due, ...stored } = item;
    const { rows } = await sql.query(`
      insert into channel_items (id, item, due, claimed_by, claimed_until) values ($1, $2, $3, $4, now() + $5 * interval '1 millisecond')
      on conflict (id) do nothing returning revision`, [item.id, JSON.stringify(stored), due, claimed ? this.host.node : null, claimed ? CLAIM_MS : null]);
    // Claimed here and worked on at once; should this invocation die, its claim lapses and a scan then retakes it.
    if (rows[0] && claimed) this.wakeAt(Date.now() + CLAIM_MS + 1_000);
    return rows[0] && { item, revision: rows[0].revision };
  }

  // Work items ------------------------------------------------------------------

  /** Advance every item that is due and unclaimed; any node may run this. */
  async scan(now = Date.now()) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.prune();
      for (let batch; (batch = await this.claim(now)).length;) {
        for (const claimed of batch) await this.advance(claimed).catch(error => this.failed(claimed.item, error));
        if (batch.length < CLAIM_BATCH) break;
      }
    } finally { this.scanning = false; }
  }

  /** When the earliest item not yet done comes due (or a claim on one lapses), for hosts that schedule their scans; undefined for none. */
  async nextDue(): Promise<number | undefined> {
    const { rows } = await this.host.sql.query(`
      select min(greatest(due, coalesce((extract(epoch from claimed_until) * 1000)::bigint, 0))) as due
      from channel_items where item->>'state' <> 'filtered'`);
    return rows[0]?.due == null ? undefined : Number(rows[0].due);
  }

  private async claim(now: number): Promise<Held[]> {
    const { rows } = await this.host.sql.query(`
      update channel_items set claimed_by = $2, claimed_until = now() + $3 * interval '1 millisecond', revision = revision + 1
      where id in (
        select id from channel_items where due <= $1 and (claimed_until is null or claimed_until <= now())
        order by due limit ${CLAIM_BATCH} for update skip locked)
      returning item, due, revision`, [now, this.host.node, CLAIM_MS]);
    return rows.map(held);
  }

  /** Forget seen markers and counters once no retry or window can need them. */
  private async prune() {
    if (Date.now() - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = Date.now();
    await this.host.sql.query(`delete from channel_seen where seen_at < now() - interval '${SEEN_DAYS} days' and (verdict is null or seen_at < now() - interval '${FILTERED_DAYS} days')`);
    await this.host.sql.query("delete from channel_counts where created_at < now() - interval '2 days'");
  }

  /**
   * Write the next state of an item this node holds; the revision check fences out
   * anyone who retook it. `claim` true extends this node's claim, false releases it.
   */
  private async save({ item, revision }: Held, changes: Partial<Item>, claim?: boolean, sql: Sql = this.host.sql): Promise<Held> {
    const next = { ...item, ...changes };
    for (const key of Object.keys(changes) as (keyof Item)[]) if (changes[key] === undefined) delete next[key];
    const { due, ...stored } = next;
    const { rows } = await sql.query(`
      update channel_items set item = $3, due = $4, revision = revision + 1,
        claimed_by = case when $5::boolean is null then claimed_by when $5 then $6 end,
        claimed_until = case when $5::boolean is null then claimed_until when $5 then now() + $7 * interval '1 millisecond' end
      where id = $1 and revision = $2 returning revision`, [item.id, revision, JSON.stringify(stored), due, claim ?? null, this.host.node, CLAIM_MS]);
    if (!rows[0]) throw new ItemChanged(item.id);
    // Released with a time to come back to: a host without a periodic scan is woken then (a claim held lapses on its own).
    if (claim === false) this.wakeAt(due);
    return { item: next, revision: rows[0].revision };
  }

  /** Drop a finished item, unless another node retook it since `current` was read. */
  private async finish({ item, revision }: Held) {
    await this.host.sql.query("delete from channel_items where id = $1 and revision = $2", [item.id, revision]);
  }

  /** Release a claimed item after an unexpected error, to be retried later. */
  private async failed(item: Item, error: unknown) {
    console.error(JSON.stringify({ type: "channel_item_failed", item: item.id, state: item.state, error: this.host.safeError(error) }));
    const row = (await this.host.sql.query("select item, due, revision, claimed_by from channel_items where id = $1", [item.id]).catch(() => undefined))?.rows[0];
    if (!row || row.claimed_by !== this.host.node) return;
    const current = held(row);
    const attempts = (current.item.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) return this.finish(current).catch(() => {});
    await this.save(current, { attempts, due: Date.now() + this.retryDelay(attempts - 1) }, false).catch(() => {});
  }

  private retryDelay(attempts: number) { return Math.min(10 * 60_000, (this.host.retryBaseMs ?? 2_000) * 2 ** attempts); }

  private async advance(current: Held): Promise<void> {
    const channel = await this.read(current.item.channel);
    if (!channel) return this.finish(current);
    // A filtered message comes due only when its time to be delivered is up.
    if (current.item.state === "filtered") return this.finish(current);
    // A retired type's channel answers nothing: its queued work goes.
    if (!this.served(channel)) return this.fenced(current, current.item.state === "received" ? "submit" : "send");
    if (current.item.state === "received") return this.receive(channel, current);
    if (current.item.state === "submitted") return this.recheck(channel, current);
    return this.deliver(channel, current);
  }

  private async receive(channel: Channel, current: Held) {
    const item = current.item;
    const inbound = item.inbound!;
    const reply = (text: string) => this.save(current, { state: "sending", text, sent: 0, attempts: 0 }).then(next => this.deliver(channel, next));
    if (inbound.command === "start") return reply(channel.greeting ?? DEFAULT_GREETING);
    // One someone chose to deliver is not the sender's doing, whenever it comes.
    if (!item.verdict?.deliveredAt) {
      const minute = Math.floor(Date.now() / 60_000);
      const recent = await this.count(channel.id, `m${minute}/${sha(inbound.sender.id).slice(0, 16)}`);
      // Only the first message over a limit is told why; the rest are dropped quietly.
      if (recent > channel.limits.perSenderPerMinute) return recent === channel.limits.perSenderPerMinute + 1 ? reply("You're sending messages too quickly. Please wait a minute and try again.") : this.finish(current);
    }
    const screened = await this.screen(channel, current);
    if (!screened) return;
    current = screened;
    const today = await this.count(channel.id, `d${new Date().toISOString().slice(0, 10)}/turns`);
    if (today > channel.limits.turnsPerDay) return today === channel.limits.turnsPerDay + 1 ? reply("This assistant has reached its limit for today. Please try again tomorrow.") : this.finish(current);
    const { credentials } = this.secrets(channel);
    if (this.host.ownership?.fresh() !== false) void this.provider(channel.type).typing?.(credentials, item.conversationId).catch(() => {});
    const agent = await this.agentFor(channel, item.conversationId, inbound.sender, inbound.title);
    // A reply to the question the agent waits on answers it; anything else is a new message, which supersedes it.
    if (await this.answerInput(channel, agent, inbound)) return this.finish(current);
    const prompt = this.prompt(channel, inbound, await this.attach(channel, credentials, agent, item.id, inbound.files ?? []));
    // Submitted before submitting: the turn may end (and its reply be settled) before submit returns.
    const next = await this.save(current, { state: "submitted", agent, prompt, due: Date.now() + (this.host.recheckMs ?? RECHECK_MS) }, false);
    // Channels run unattended: a turn goes ahead without the application, whose calls fail as not connected.
    try {
      await this.host.submit(agent, channel.tenant, { id: item.id, method: "prompt", params: { ...prompt, allowDisconnected: true } });
    }
    catch (error) {
      console.error(JSON.stringify({ type: "channel_submit_failed", item: item.id, error: this.host.safeError(error) }));
      await this.save(next, { due: Date.now() + this.retryDelay(0) }).catch(() => {});
      this.wakeAt(Date.now() + this.retryDelay(0));
    }
  }

  /**
   * Put a message to its channel's filter, if any and if not yet asked: the item, or undefined when the filter left it
   * out. The verdict and the item's next state commit together, so a retake (or a delivery) does not ask again; a node
   * lost during the call does, and pays for the second answer.
   */
  private async screen(channel: Channel, current: Held): Promise<Held | undefined> {
    const { item } = current;
    if (!channel.filter || item.verdict) return current;
    const verdict = await this.verdict(channel, channel.filter, item);
    const filtered = verdict.outcome === "filtered";
    console.log(JSON.stringify({ type: "channel_filter", channel: channel.id, item: item.id, outcome: verdict.outcome, reason: verdict.reason, ...(verdict.ms !== undefined ? { ms: verdict.ms } : {}), ...(verdict.error ?? {}) }));
    const next = await this.host.transaction(async sql => {
      await sql.query("update channel_seen set verdict = $3 where channel = $1 and message = $2", [channel.id, seenKey(item.inbound!.messageId), JSON.stringify(verdict)]);
      return this.save(current, filtered ? { verdict, state: "filtered", due: Date.now() + FILTERED_DAYS * 86_400_000 } : { verdict }, !filtered, sql);
    });
    return filtered ? undefined : next;
  }

  /** The filter's say on a message. No answer lets it through: an outage must not drop a customer's email. */
  private async verdict(channel: Channel, filter: ChannelFilter, item: Item): Promise<Verdict> {
    const inbound = item.inbound!;
    const facts = { item: item.id, conversation: item.conversationId, at: Date.now(), threshold: filter.threshold };
    const passed = (reason: VerdictReason): Verdict => ({ ...facts, outcome: "passed", reason });
    if (!inbound.text.trim()) return passed("no_text");
    const agent = (await this.host.sql.query("select agent from channel_conversations where channel = $1 and conversation = $2", [channel.id, item.conversationId])).rows[0]?.agent as string | undefined;
    if (agent && (inbound.followUp || inbound.continuation)) return passed("follow_up");
    if (agent && await this.awaitedAnswer(agent, inbound)) return passed("answers_input");
    try {
      const decisions = this.host.decisions;
      if (!decisions) throw new HttpError(503, "Decisions are not enabled on this runtime");
      const { spec } = await this.host.definitions.read(channel.tenant, channel.definition);
      const { instructions, criteria } = filter;
      const answered = await decisions.ask(channel.tenant, {
        items: [{ state: filterState(channel.type, inbound), questions: { [FILTER_QUESTION]: { type: "noul", instructions, ...(criteria ? { criteria } : {}) } } }],
        batch: false, model: DECISION_MODEL, actor: `channel:${channel.id}`, ...(spec.dataCollection ? { dataCollection: spec.dataCollection } : {}),
      }, AbortSignal.timeout(FILTER_TIMEOUT_MS)) as { answers?: Record<string, { type: string; noul?: number }>; model?: string; costUsd?: number; ms?: number };
      const answer = "answers" in answered ? answered.answers?.[FILTER_QUESTION] : undefined;
      if (answer?.type !== "noul") throw new HttpError(502, "The decision came back without an answer");
      return { ...facts, outcome: answer.noul! >= filter.threshold ? "passed" : "filtered", reason: "score", score: answer.noul!, model: answered.model, costUsd: answered.costUsd, ms: answered.ms };
    } catch (error) {
      const { status, code } = error as { status?: number; code?: unknown };
      console.error(JSON.stringify({ type: "channel_filter_failed", channel: channel.id, item: item.id, error: this.host.safeError(error) }));
      return { ...passed("decision_failed"), error: { status: status ?? 504, ...(typeof code === "string" ? { code } : {}) } };
    }
  }

  /** Whether a message answers the input an agent waits on (see `answerInput`), which no filter may stand in front of. */
  private async awaitedAnswer(agent: string, inbound: Inbound) {
    const inputs = this.host.inputs;
    if (!inputs || inbound.unverified || inbound.files?.length) return false;
    const input = (await inputs.pending(agent))[0];
    return !!input && !!answerOf(input, inbound.text);
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
      if (index >= CHANNEL_FILE_LIMITS.files || !this.host.files) { notes.push(`(file ${file.name} not attached)`); continue; }
      if ((file.size ?? 0) > limit) { notes.push(`(file ${file.name} too large, not attached)`); continue; }
      // Two attachments of one name become name, name-2, ...
      let name = file.name;
      for (let n = 2; names.has(name); n++) name = file.name.replace(/(\.[^.]*)?$/, extension => `-${n}${extension}`);
      names.add(name);
      let size = 0;
      try {
        const { body, contentType } = file.content !== undefined ? { body: [decodeBase64(file.content)], contentType: undefined } : await provider.download(credentials, file);
        const counted = async function* () {
          for await (const chunk of body) {
            if ((size += chunk.length) > limit) throw new Error("too large");
            yield chunk;
          }
        };
        files.push({ path: (await this.host.files.upload(agent, channel.tenant, requestId, name, counted(), file.contentType ?? contentType)).path });
        total += size;
      } catch (error) {
        console.error(JSON.stringify({ type: "channel_attachment_failed", channel: channel.id, request: requestId, error: this.host.safeError(error) }));
        notes.push(size > limit ? `(file ${file.name} too large, not attached)` : `(file ${file.name} could not be downloaded, not attached)`);
      }
    }
    return { files, notes };
  }

  /** The message, and who sent it: the runtime shows the model the sender apart from what they wrote. */
  private prompt(channel: Channel, inbound: Inbound, { files, notes }: { files: { path: string }[]; notes: string[] }) {
    return promptOf(channel.type, inbound, files, notes);
  }

  /**
   * Answer the input the conversation's agent waits on (its oldest) with this message, when the
   * message is an answer to it (see `answerOf`) from someone allowed to answer. The next waiting
   * input, if any, is asked right away. False when the message is not an answer.
   */
  private async answerInput(channel: Channel, agent: string, inbound: Inbound): Promise<boolean> {
    const inputs = this.host.inputs;
    // An approval or an answer is only a proven sender's to give.
    const input = inputs && !inbound.unverified && !inbound.files?.length ? (await inputs.pending(agent))[0] : undefined;
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
    let record: ChannelRun;
    // Rechecking an existing request must still retrieve its reply after credit is exhausted.
    // The submission service enforces current credit if this id was never accepted.
    try { record = await this.host.submit(item.agent!, channel.tenant, { id: item.id, method: "prompt", params: { ...item.prompt!, allowDisconnected: true } }); }
    catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 410) return this.finish(current);
      throw error;
    }
    if (record.state !== "completed") { await this.save(current, { due: Date.now() + (this.host.recheckMs ?? RECHECK_MS) }, false); return; }
    const reply = this.replyOf(record);
    if (!reply.text && !reply.files.length) return this.finish(current);
    await this.deliver(channel, await this.save(current, { state: "sending", ...reply, sent: 0, attempts: 0 }));
  }

  private async deliver(channel: Channel, current: Held) {
    const provider = this.provider(channel.type);
    if (provider.replies?.(channel.settings ?? {}) === false) return this.finish(current);
    const { credentials } = this.secrets(channel);
    const item = current.item;
    const steps = [
      ...chunks(item.text ?? "", provider.maxMessageLength).map(part => () => provider.send(credentials, item.conversationId, part)),
      ...(item.files ?? []).map(file => () => this.sendFile(provider, credentials, item, file)),
    ];
    for (let index = item.sent ?? 0; index < steps.length; index++) {
      try {
        // Only while this node's lease is fresh: a node cut off from its peers and the database may have been taken for dead.
        await this.host.ownership?.whenFresh();
        await steps[index]!();
      }
      catch (error) {
        const attempts = (current.item.attempts ?? 0) + 1;
        const permanent = error instanceof SendError && error.permanent;
        console.error(JSON.stringify({ type: "channel_send_failed", item: current.item.id, attempts, permanent, error: this.host.safeError(error) }));
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
    const files = this.host.files;
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    const caption = file.caption?.slice(0, 1000);
    if (files && file.size <= provider.maxFileBytes) {
      const blob = async () => {
        const parts: Uint8Array[] = [];
        for await (const part of files.read(item.tenant, file)) parts.push(part);
        const data = new Blob(parts as Uint8Array<ArrayBuffer>[], { type: file.contentType });
        // Never send a file short: fail the send (it is retried) and say which part came back short.
        if (data.size !== file.size) {
          console.error(JSON.stringify({ type: "channel_file_size_mismatch", item: item.id, volume: file.volume, version: file.version, size: file.size, read: data.size, chunks: Array.isArray(file.chunks) ? file.chunks.length : undefined, parts: parts.map(part => part.byteLength) }));
          throw new SendError(`${name} read ${data.size} of its ${file.size} bytes`, false);
        }
        return data;
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
  private async enqueue(agent: ChannelAgent, binding: Binding, id: string, text: string, files: Presented[] = []) {
    const now = Date.now();
    const write = (sql: Sql) => this.insert(sql, {
      id, channel: binding.channel, tenant: binding.tenant, conversationId: binding.conversationId, createdAt: now,
      state: "sending", agent: agent.id, text, ...(files.length ? { files } : {}), sent: 0, attempts: 0, due: now,
    });
    const created = this.host.underClaim ? await this.host.underClaim(agent, write) : await write(this.host.sql);
    if (!created) return;
    const channel = await this.read(binding.channel);
    if (!channel || !this.served(channel)) return this.finish(created);
    await this.deliver(channel, created).catch(error => this.failed(created.item, error));
  }

  /** A channel of a retired type drops the item: say so, since nothing reaches the conversation. */
  private fenced(current: Held, phase: string) {
    console.log(JSON.stringify({ type: "channel_item_fenced", channel: current.item.channel, item: current.item.id, phase }));
    return this.finish(current);
  }

  /** Count one event in a window, across nodes; returns the new count. */
  private async count(channel: string, window: string): Promise<number> {
    const { rows } = await this.host.sql.query(`
      insert into channel_counts (channel, window_key, count) values ($1, $2, 1)
      on conflict (channel, window_key) do update set count = channel_counts.count + 1 returning count`, [channel, window]);
    return rows[0].count;
  }

  /** The conversation's agent, created on first contact (and again if it expired or was deleted). */
  private async agentFor(channel: Channel, conversationId: string, sender: Sender, title?: string) {
    const stored = (await this.host.sql.query("select agent, generation from channel_conversations where channel = $1 and conversation = $2", [channel.id, conversationId])).rows[0] as { agent: string; generation: number } | undefined;
    if (stored && await this.host.live(stored.agent, channel.tenant)) return stored.agent;
    const generation = stored ? stored.generation + 1 : 0;
    const label = title ?? (sender.username ? `@${sender.username}` : sender.name ?? sender.id);
    const params = {
      definition: channel.definition,
      name: `${this.provider(channel.type).label}: ${label}`.slice(0, 120), type: "channel",
      // A conversation outlives any session TTL: its agent lives until deleted (DELETE /v1/agents/:id).
      ttlSeconds: null,
    };
    const key = conversationAgentKey(channel, conversationId, generation);
    // Bound first: the agent lists its tools (send_message among them) as it starts.
    const id = await this.host.agentId(channel.tenant, key);
    const binding: Binding = { channel: channel.id, tenant: channel.tenant, conversationId };
    await this.host.sql.query(`
      insert into channel_agents (agent, channel, tenant, conversation) values ($1, $2, $3, $4)
      on conflict (agent) do update set channel = excluded.channel, tenant = excluded.tenant, conversation = excluded.conversation`, [id, channel.id, channel.tenant, conversationId]);
    this.bindings.set(id, Promise.resolve(binding));
    const created = await this.host.createAgent(channel.tenant, params, key);
    await this.host.sql.query(`
      insert into channel_conversations (channel, conversation, agent, generation) values ($1, $2, $3, $4)
      on conflict (channel, conversation) do update set agent = excluded.agent, generation = excluded.generation`, [channel.id, conversationId, created.id, generation]);
    return created.id;
  }

  /** The conversation an agent answers, if it is a channel's agent. */
  binding(agent: string) {
    let binding = this.bindings.get(agent);
    if (!binding) {
      if (this.bindings.size > 10_000) this.bindings.clear();
      binding = this.host.sql.query("select channel, tenant, conversation from channel_agents where agent = $1", [agent])
        .then(({ rows }) => rows[0] && { channel: rows[0].channel, tenant: rows[0].tenant, conversationId: rows[0].conversation });
      binding.catch(() => this.bindings.delete(agent));
      this.bindings.set(agent, binding);
    }
    return binding;
  }

  // Agent hooks -----------------------------------------------------------------

  /** How to show that a channel agent's reply is coming, or undefined when its service has no indicator; hosts repeat it every `every` ms. */
  async typing(agent: string): Promise<{ show(): Promise<void>; every: number } | undefined> {
    const binding = await this.binding(agent);
    const channel = binding && await this.read(binding.channel);
    if (!binding || !channel || !this.served(channel)) return undefined;
    const provider = this.provider(channel.type);
    if (!provider.typing) return undefined;
    const { credentials } = this.secrets(channel);
    return {
      every: provider.typingMs ?? TYPING_MS,
      show: async () => { if (this.host.ownership?.fresh() !== false) await provider.typing!(credentials, binding.conversationId); },
    };
  }

  /** send_message: queue a message (text, files from the agent's mounts) to the agent's conversation. Undefined for an agent of no channel. */
  async sendMessage(agent: ChannelAgent, args: Record<string, unknown>): Promise<{ sent: true }> {
    const binding = await this.binding(agent.id);
    if (!binding) throw new Error("This agent answers no channel conversation");
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const paths = Array.isArray(args.files) ? args.files.map(String) : [];
    if (!text && !paths.length) throw new Error("send_message needs text or files");
    const files = this.host.files;
    if (paths.length && !files) throw new Error("This runtime cannot send files");
    // Each must be a file in the agent's mounts; its reference pins the version sent.
    const refs = await Promise.all(paths.map(path => files!.ref(agent.id, agent.tenant, path)));
    await this.enqueue(agent, binding, `msg_${crypto.randomUUID().replaceAll("-", "")}`, text, refs);
    return { sent: true };
  }

  /** What a tool call of a channel agent's run is told of where it came from: the channel, the conversation and the sender. */
  async origin(agent: ChannelAgent, requestId?: string) {
    const binding = await this.binding(agent.id);
    if (!binding) return undefined;
    const channel = await this.read(binding.channel);
    const item = requestId?.startsWith("in_") ? (await this.host.sql.query("select item from channel_items where id = $1", [requestId])).rows[0]?.item as Item | undefined : undefined;
    const sender = item?.agent === agent.id ? item.inbound?.sender : undefined;
    return { channel: { id: binding.channel, type: channel?.type }, conversationId: binding.conversationId, ...(sender ? { sender: item!.inbound!.unverified ? { ...sender, unverified: true } : sender } : {}) };
  }

  /** A channel agent's turn ended: its reply goes to the conversation, and the first input it waits on, if any. */
  async settle(agent: ChannelAgent, record: ChannelRun) {
    const binding = await this.binding(agent.id);
    if (!binding) return;
    const reply = this.replyOf(record);
    const waiting = (record.outcome?.result as { inputs?: PendingInput[] } | undefined)?.inputs?.[0];
    if (waiting) reply.text = [reply.text, askText(waiting)].filter(Boolean).join("\n\n");
    const empty = !reply.text && !reply.files.length;
    if (!record.id.startsWith("in_")) {
      // Turns not started by a message (schedules, the API) count against the channel's daily turns, and past it do not reply.
      const channel = record.method === "prompt" ? await this.read(binding.channel) : undefined;
      if (channel && await this.count(channel.id, `d${new Date().toISOString().slice(0, 10)}/turns`) > channel.limits.turnsPerDay) {
        console.log(JSON.stringify({ type: "channel_turn_over_limit", channel: channel.id, agent: agent.id, request: record.id }));
        return;
      }
      // They reply to the conversation too.
      if (!empty) await this.enqueue(agent, binding, `out_${sha(`${agent.id}:${record.id}`).slice(0, 40)}`, reply.text, reply.files);
      return;
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const row = (await this.host.sql.query("select item, due, revision from channel_items where id = $1", [record.id])).rows[0];
      const stored = row && held(row);
      if (!stored || stored.item.state !== "submitted" || stored.item.agent !== agent.id) return;
      if (empty) return this.finish(stored);
      let next: Held;
      try { next = await this.save(stored, { state: "sending", ...reply, sent: 0, attempts: 0, due: Date.now() }, true); }
      catch (error) { if (error instanceof ItemChanged) continue; throw error; }
      const channel = await this.read(binding.channel);
      if (!channel) return this.finish(next);
      return this.deliver(channel, next).catch(error => this.failed(next.item, error));
    }
  }

  /** What a finished prompt says back: the final answer and the files it presented, or an apology when the turn failed. */
  private replyOf(record: ChannelRun): { text: string; files: Presented[] } {
    return replyOf(record, this.host.isFile);
  }
}

const decodeBase64 = (text: string) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** A message as a prompt: its text with notes on files left out, and its sender apart from what they wrote. */
export function promptOf(type: string, inbound: Inbound, files: { path: string }[], notes: string[]) {
  const { id, name, username } = inbound.sender;
  const from = { id: `${type}:${inbound.unverified ? "unverified:" : ""}${id}`, ...(name ? { name: name.slice(0, 200) } : {}), ...(username ? { username: username.slice(0, 200) } : {}) };
  const text = [inbound.text, ...notes].filter(Boolean).join("\n") || (files.length === 1 ? "(sent a file)" : files.length ? `(sent ${files.length} files)` : "");
  return { text, from, ...(files.length ? { files } : {}) };
}

/**
 * An input as a message: a question's options numbered, an approval as the runtime's card of the
 * call, a URL step with its address and site, and a confirmation or one-field form.
 */
export function askText(input: PendingInput): string {
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
    return [`Approve this action? ${input.detail.tool} (${input.detail.source}) with ${input.detail.argumentsPreview ?? JSON.stringify(input.detail.arguments)}`, ...input.detail.reason ? [`The tool says: ${input.detail.reason}`] : [], "Reply approve or deny."].join("\n");
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
export function answerOf(input: PendingInput, text: string): { action: "accept" | "decline"; content?: unknown } | undefined {
  const said = text.trim().replace(/[.!]+$/, "").toLowerCase();
  const fields = Object.entries((input.detail.requestedSchema?.properties ?? {}) as Record<string, { type?: string }>);
  if (input.kind === "approval" || (input.kind === "form" && !fields.length)) {
    if (["approve", "approved", "yes", "y"].includes(said)) return input.kind === "form" ? { action: "accept", content: {} } : { action: "accept" };
    return ["deny", "denied", "no", "n"].includes(said) ? { action: "decline" } : undefined;
  }
  if (input.kind === "url") return said === "done" ? { action: "accept" } : undefined;
  if (input.kind === "form") {
    if (fields.length !== 1) return undefined;
    const [name, field] = fields[0]!;
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
    const parts = question.multiSelect ? lines[index]!.split(",").map(part => part.trim()).filter(Boolean) : [lines[index]!];
    const chosen = parts.map(choose);
    if (chosen.every(Boolean)) answers[question.question] = question.multiSelect ? chosen as string[] : chosen[0]!;
    else if (question.allowOther && lines[index]) answers[question.question] = question.multiSelect ? [lines[index]!] : lines[index]!;
    else return undefined;
  }
  return { action: "accept", content: { answers } };
}

/** What a finished prompt says back: the final answer and the files it presented, or an apology when the turn failed. */
export function replyOf(record: ChannelRun, isFile: (value: unknown) => boolean = value => !!value && (value as Presented).type === "file"): { text: string; files: Presented[] } {
  const outcome = record.outcome;
  const result = outcome?.result as { reply?: string; error?: string | null; presented?: unknown[] } | undefined;
  if (!outcome || outcome.error !== undefined || result?.error) return { text: FAILED_REPLY, files: [] };
  const files = (Array.isArray(result?.presented) ? result.presented : []).filter(isFile) as Presented[];
  return { text: result?.reply ?? "", files };
}
