import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Accounts, Sealed } from "./accounts.ts";
import type { AgentRef, SessionHooks } from "./client-sessions.ts";
import type { ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import { resolveModel } from "./session-config.ts";
import { validateDefinitions } from "./tool-policy.ts";
import { HttpError, readText } from "./http.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { PreconditionFailed, type Storage } from "../shared/storage.ts";

/**
 * Channels let people talk to agents through messaging services. Each external
 * conversation gets its own agent, created on first contact from the channel's
 * template; a message becomes a prompt, and the turn's reply goes back the same way.
 * Everything is in shared storage, so any node can take a webhook or send a reply:
 *
 *   channels/<id>                         the channel: template, access, limits, sealed credentials
 *   channel-index/<tenant>/<id>           a tenant's channels
 *   channel-conversations/<id>/<conv>     the agent answering one external conversation
 *   channel-agents/<agent>                the conversation an agent answers
 *   channel-items/<item>                  live work: an inbound message until its reply is sent, or an outbound message
 *   channel-seen/<id>/<hash>              inbound messages already handled, so provider retries are dropped
 *   channel-counts/<id>/<window>/<who>    rate-limit and daily-turn counters
 *
 * Items move received → submitted → sending by conditional writes, and whoever
 * holds an item's claim is the only node advancing it, so a reply is sent once.
 */
export interface Sender { id: string; username?: string; name?: string }
export interface Inbound {
  conversationId: string;
  /** The provider's id for this message, unique within the channel; retries repeat it. */
  messageId: string;
  sender: Sender; text: string;
  /** Provider references to images, fetched when the message is processed. */
  images: string[];
  command?: "start";
}
type Credentials = Record<string, string>;
/** What the core needs from a messaging service; everything provider-specific lives behind it. */
export interface ChannelProvider {
  readonly label: string;
  readonly maxMessageLength: number;
  /** Validate credentials and point the service's webhook at `webhook.url`. */
  setup(credentials: Credentials, webhook: { url: string; secret: string }): Promise<{ account: Record<string, string>; masked: Record<string, string> }>;
  teardown(credentials: Credentials): Promise<void>;
  verify(headers: Headers, body: string, secret: string): boolean;
  /** An inbound message, or undefined for updates the channel ignores. */
  parse(body: unknown): Inbound | undefined;
  images(credentials: Credentials, references: string[]): Promise<ImageContent[]>;
  send(credentials: Credentials, conversationId: string, text: string): Promise<void>;
  typing(credentials: Credentials, conversationId: string): Promise<void>;
}
/** A failed send; permanent failures (blocked bot, unknown chat) are not retried. */
export class SendError extends Error {
  permanent: boolean; retryAfterMs?: number;
  constructor(message: string, permanent: boolean, retryAfterMs?: number) { super(message); this.permanent = permanent; this.retryAfterMs = retryAfterMs; }
}

export interface Template { model?: string; systemPrompt?: string; thinkingLevel?: string; tools?: ToolDefinition[] }
export interface Channel {
  id: string; tenant: string; type: string; name: string; webhookUrl: string;
  template: Template;
  /** Senders by id or @username; `public` lets anyone in. */
  access: { public: boolean; allow: string[] };
  limits: { perSenderPerMinute: number; turnsPerDay: number };
  greeting?: string;
  account: Record<string, string>;
  masked: Record<string, string>;
  sealed: Sealed;
  createdAt: number; updatedAt: number;
}
export type ChannelInput = Partial<Pick<Channel, "name" | "template" | "greeting">> & {
  type?: string; credentials?: Credentials;
  access?: Partial<Channel["access"]>; limits?: Partial<Channel["limits"]>;
};
type Binding = { channel: string; tenant: string; conversationId: string };
type Item = {
  id: string; channel: string; tenant: string; conversationId: string; createdAt: number;
  state: "received" | "submitted" | "sending";
  /** Not before this time: the next retry or re-check. */
  due: number;
  claim?: { node: string; until: number };
  inbound?: Inbound;
  agent?: string; prompt?: { text: string; images?: ImageContent[] };
  text?: string; sent?: number; attempts?: number;
};

export const SEND_MESSAGE: ToolDefinition = {
  name: "send_message",
  description: "Send a message to the person you are talking with right away, before your final reply: for progress updates during long work. Your final reply is sent automatically; do not repeat it here.",
  parameters: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 16_000 } }, additionalProperties: false },
  exposure: "direct",
};
const DEFAULT_LIMITS = { perSenderPerMinute: 10, turnsPerDay: 1_000 };
const DEFAULT_GREETING = "Hi! Send me a message to get started.";
const FAILED_REPLY = "Sorry, something went wrong while answering. Please try again.";
/** A claim older than this is assumed abandoned by a crashed node and may be retaken. */
const CLAIM_MS = 60_000;
/** How often a submitted message's turn is checked when its end was not observed (a crash). */
const RECHECK_MS = 60_000;
const MAX_ATTEMPTS = 8;
const MAX_REPLY = 32_000;
const TYPING_MS = 4_000;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const itemKey = (id: string) => `channel-items/${id}`;
const validConversation = (value: string) => /^[A-Za-z0-9_.-]{1,64}$/.test(value);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
  storage: Storage; accounts: Accounts; node: string; publicUrl: string;
  providers: Record<string, ChannelProvider>;
  createAgent(tenant: string, params: any, key: string): Promise<{ id: string }>;
  /** Whether the agent still exists and is the tenant's. */
  live(agent: string, tenant: string): Promise<boolean>;
  /** Submit a request to an agent on whichever node serves it. */
  submit(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }): Promise<RequestRecord>;
  retryBaseMs?: number;
}

export class Channels {
  readonly storage: Storage;
  private readonly options: ChannelsOptions;
  private readonly bindings = new Map<string, Promise<Binding | undefined>>();
  private readonly typing = new Map<string, ReturnType<typeof setInterval>>();
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;

  constructor(options: ChannelsOptions) {
    this.options = options;
    this.storage = options.storage;
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
  }

  // Configuration ---------------------------------------------------------------

  private provider(type: string) {
    const provider = Object.hasOwn(this.options.providers, type) ? this.options.providers[type] : undefined;
    if (!provider) throw new HttpError(400, `Unknown channel type ${type}; supported: ${Object.keys(this.options.providers).join(", ")}`);
    return provider;
  }
  private async read(id: string) {
    if (!/^ch_[a-f0-9]{20}$/.test(id)) return undefined;
    return (await this.storage.readJson<Channel>(`channels/${id}`))?.value;
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
    const keys = await this.storage.listJson(`channel-index/${tenant}/`);
    const channels = await Promise.all(keys.map(key => this.read(key.slice(key.lastIndexOf("/") + 1))));
    return channels.filter((channel): channel is Channel => !!channel && channel.tenant === tenant).sort((a, b) => a.createdAt - b.createdAt).map(channel => this.view(channel));
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
    const channel: Channel = {
      id, tenant, type, name: input.name ?? `${provider.label} ${account.username ? `@${account.username}` : id}`, webhookUrl,
      template: settings.template ?? {}, access: { public: false, allow: [], ...settings.access }, limits: { ...DEFAULT_LIMITS, ...settings.limits },
      ...(settings.greeting ? { greeting: settings.greeting } : {}), account, masked,
      sealed: this.options.accounts.seal(`channel:${id}`, JSON.stringify({ credentials: input.credentials, secret })), createdAt: now, updatedAt: now,
    };
    await this.storage.writeJson(`channels/${id}`, channel, null);
    await this.storage.writeJson(`channel-index/${tenant}/${id}`, {});
    return this.view(channel);
  }

  async update(tenant: string, id: string, input: ChannelInput) {
    const channel = await this.owned(tenant, id);
    if (input.type !== undefined && input.type !== channel.type) throw new HttpError(400, "A channel's type cannot change");
    const settings = this.settings(input);
    const next: Channel = {
      ...channel, ...(input.name !== undefined ? { name: input.name } : {}),
      ...(settings.template ? { template: settings.template } : {}),
      access: { ...channel.access, ...settings.access }, limits: { ...channel.limits, ...settings.limits },
      ...(settings.greeting !== undefined ? { greeting: settings.greeting } : {}), updatedAt: Date.now(),
    };
    if (input.credentials) {
      const provider = this.provider(channel.type);
      const old = this.secrets(channel).credentials;
      const secret = randomBytes(32).toString("hex");
      Object.assign(next, await provider.setup(input.credentials, { url: channel.webhookUrl, secret }));
      next.sealed = this.options.accounts.seal(`channel:${id}`, JSON.stringify({ credentials: input.credentials, secret }));
      // A different bot keeps its webhook pointed here otherwise.
      if (next.account.id !== channel.account.id) await provider.teardown(old).catch(() => {});
    }
    await this.storage.writeJson(`channels/${id}`, next);
    return this.view(next);
  }

  async remove(tenant: string, id: string) {
    const channel = await this.owned(tenant, id);
    try { await this.provider(channel.type).teardown(this.secrets(channel).credentials); }
    catch (error) { console.error(JSON.stringify({ type: "channel_teardown_failed", channel: id, error: errorText(error) })); }
    await this.storage.deleteJson(`channels/${id}`);
    await this.storage.deleteJson(`channel-index/${tenant}/${id}`);
  }

  private settings(input: ChannelInput) {
    const template = input.template;
    if (template) {
      if (template.model !== undefined) resolveModel(template.model);
      if (template.tools !== undefined) {
        validateDefinitions([...template.tools, SEND_MESSAGE]);
      }
    }
    return { template, access: input.access, limits: input.limits, greeting: input.greeting };
  }

  // Inbound ---------------------------------------------------------------------

  /** Public webhooks, mounted before any authentication: each request proves itself with the channel's secret. */
  readonly app = new Hono().post("/channels/:type/:id", async c => {
    const channel = await this.read(c.req.param("id"));
    if (!channel || channel.type !== c.req.param("type")) return c.body(null, 404);
    let body: string;
    try { body = await readText(c.req.raw.body, 1_000_000); } catch { return c.body(null, 413); }
    const provider = this.provider(channel.type);
    if (!provider.verify(c.req.raw.headers, body, this.secrets(channel).secret)) return c.body(null, 401);
    let inbound: Inbound | undefined;
    try { inbound = provider.parse(JSON.parse(body)); } catch { return c.body(null, 400); }
    // Anything the channel does not handle, or from someone not allowed, is acknowledged and dropped.
    if (!inbound || !validConversation(inbound.conversationId) || !this.allowed(channel, inbound.sender)) return c.body(null, 200);
    const recorded = await this.record(channel, inbound);
    if (recorded) void this.advance(recorded.item, recorded.version).catch(error => this.failed(recorded.item, error));
    return c.body(null, 200);
  });

  allowed(channel: Channel, sender: Sender) {
    if (channel.access.public) return true;
    const username = sender.username?.toLowerCase();
    return channel.access.allow.some(entry => {
      const normalized = entry.trim().replace(/^@/, "").toLowerCase();
      return normalized === sender.id || (!!username && normalized === username);
    });
  }

  private seenKey(channel: string, messageId: string) { return `channel-seen/${channel}/${sha(messageId).slice(0, 40)}`; }

  /** Durably record a message before acknowledging it; false for one already recorded. */
  private async record(channel: Channel, inbound: Inbound) {
    const seen = this.seenKey(channel.id, inbound.messageId);
    if (await this.storage.readJson(seen)) return undefined;
    const now = Date.now();
    const item: Item = {
      id: `in_${sha(`${channel.id}:${inbound.messageId}`).slice(0, 40)}`, channel: channel.id, tenant: channel.tenant, conversationId: inbound.conversationId,
      createdAt: now, state: "received", due: now, claim: { node: this.options.node, until: now + CLAIM_MS }, inbound,
    };
    let version: string;
    try { version = await this.storage.writeJson(itemKey(item.id), item, null); }
    catch (error) { if (error instanceof PreconditionFailed) return undefined; throw error; }
    // The first copy may have finished between the check above and the create.
    if (await this.storage.readJson(seen)) { await this.storage.deleteJson(itemKey(item.id)); return undefined; }
    return { item, version };
  }

  // Work items ------------------------------------------------------------------

  /** Advance every item that is due and unclaimed; any node may run this. */
  async scan(now = Date.now()) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const key of await this.storage.listJson("channel-items/")) {
        const claimed = await this.claim(key, now).catch(error => { console.error(JSON.stringify({ type: "channel_claim_failed", key, error: errorText(error) })); return undefined; });
        if (claimed) await this.advance(claimed.item, claimed.version).catch(error => this.failed(claimed.item, error));
      }
    } finally { this.scanning = false; }
  }

  private async claim(key: string, now = Date.now()) {
    const stored = await this.storage.readJson<Item>(key);
    if (!stored) return undefined;
    const item = stored.value;
    if (item.due > now || (item.claim && item.claim.until > now)) return undefined;
    const claimed = { ...item, claim: { node: this.options.node, until: Date.now() + CLAIM_MS } };
    try { return { item: claimed, version: await this.storage.writeJson(key, claimed, stored.version) }; }
    catch (error) { if (error instanceof PreconditionFailed) return undefined; throw error; }
  }

  /** Write the next state of an item this node holds; the version check fences out anyone who retook it. */
  private async save(item: Item, version: string, changes: Partial<Item>) {
    const next = { ...item, ...changes };
    for (const key of Object.keys(changes) as (keyof Item)[]) if (changes[key] === undefined) delete next[key];
    return { item: next, version: await this.storage.writeJson(itemKey(item.id), next, version) };
  }

  private async finish(item: Item) {
    if (item.inbound) await this.storage.writeJson(this.seenKey(item.channel, item.inbound.messageId), { at: Date.now() });
    await this.storage.deleteJson(itemKey(item.id));
  }

  /** Release a claimed item after an unexpected error, to be retried later. */
  private async failed(item: Item, error: unknown) {
    console.error(JSON.stringify({ type: "channel_item_failed", item: item.id, state: item.state, error: errorText(error) }));
    const stored = await this.storage.readJson<Item>(itemKey(item.id)).catch(() => undefined);
    if (!stored || stored.value.claim?.node !== this.options.node) return;
    const { claim: _claim, ...rest } = stored.value;
    const attempts = (rest.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) return this.finish(rest).catch(() => {});
    await this.storage.writeJson(itemKey(item.id), { ...rest, attempts, due: Date.now() + this.retryDelay(attempts - 1) }, stored.version).catch(() => {});
  }

  private retryDelay(attempts: number) { return Math.min(10 * 60_000, (this.options.retryBaseMs ?? 2_000) * 2 ** attempts); }

  private async advance(item: Item, version: string): Promise<void> {
    const channel = await this.read(item.channel);
    if (!channel) return this.finish(item);
    if (item.state === "received") return this.receive(channel, item, version);
    if (item.state === "submitted") return this.recheck(channel, item, version);
    return this.deliver(channel, item, version);
  }

  private async receive(channel: Channel, item: Item, version: string) {
    const inbound = item.inbound!;
    const reply = (text: string) => this.save(item, version, { state: "sending", text, sent: 0, attempts: 0 }).then(next => this.deliver(channel, next.item, next.version));
    if (inbound.command === "start") return reply(channel.greeting ?? DEFAULT_GREETING);
    const minute = Math.floor(Date.now() / 60_000);
    const recent = await this.count(`${channel.id}/m${minute}/${sha(inbound.sender.id).slice(0, 16)}`);
    // Only the first message over a limit is told why; the rest are dropped quietly.
    if (recent > channel.limits.perSenderPerMinute) return recent === channel.limits.perSenderPerMinute + 1 ? reply("You're sending messages too quickly. Please wait a minute and try again.") : this.finish(item);
    const today = await this.count(`${channel.id}/d${new Date().toISOString().slice(0, 10)}/turns`);
    if (today > channel.limits.turnsPerDay) return today === channel.limits.turnsPerDay + 1 ? reply("This assistant has reached its limit for today. Please try again tomorrow.") : this.finish(item);
    const { credentials } = this.secrets(channel);
    void this.provider(channel.type).typing(credentials, item.conversationId).catch(() => {});
    const agent = await this.agentFor(channel, item.conversationId, inbound.sender);
    const images = inbound.images.length ? await this.provider(channel.type).images(credentials, inbound.images) : [];
    const prompt = { text: this.promptText(channel, inbound, images.length), ...(images.length ? { images } : {}) };
    // Submitted before submitting: the turn may end (and its reply be settled) before submit returns.
    const next = await this.save(item, version, { state: "submitted", agent, prompt, claim: undefined, due: Date.now() + RECHECK_MS });
    try { await this.options.submit(agent, channel.tenant, { id: item.id, method: "prompt", params: prompt }); }
    catch (error) {
      console.error(JSON.stringify({ type: "channel_submit_failed", item: item.id, error: errorText(error) }));
      await this.storage.writeJson(itemKey(item.id), { ...next.item, due: Date.now() + this.retryDelay(0) }, next.version).catch(() => {});
    }
  }

  /** The sender's identity, as context the agent can rely on (the runtime sets it, not the sender). */
  private promptText(channel: Channel, inbound: Inbound, images: number) {
    const who = [inbound.sender.name, inbound.sender.username && `@${inbound.sender.username}`].filter(Boolean).join(" ");
    const header = `[${this.provider(channel.type).label} message from ${who ? `${who}, ` : ""}user id ${inbound.sender.id}]`;
    return `${header}\n${inbound.text || (images ? "(sent a photo)" : "")}`;
  }

  /** A submitted message whose turn end this runtime did not see: ask again (idempotently) how it went. */
  private async recheck(channel: Channel, item: Item, version: string) {
    let record: RequestRecord;
    try { record = await this.options.submit(item.agent!, channel.tenant, { id: item.id, method: "prompt", params: item.prompt! }); }
    catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 410) return this.finish(item);
      throw error;
    }
    if (record.state !== "completed") { await this.save(item, version, { claim: undefined, due: Date.now() + RECHECK_MS }); return; }
    const text = replyText(record);
    if (!text) return this.finish(item);
    const next = await this.save(item, version, { state: "sending", text, sent: 0, attempts: 0 });
    await this.deliver(channel, next.item, next.version);
  }

  private async deliver(channel: Channel, item: Item, version: string) {
    const provider = this.provider(channel.type);
    const parts = chunks(item.text ?? "", provider.maxMessageLength);
    const { credentials } = this.secrets(channel);
    for (let index = item.sent ?? 0; index < parts.length; index++) {
      try { await provider.send(credentials, item.conversationId, parts[index]); }
      catch (error) {
        const attempts = (item.attempts ?? 0) + 1;
        const permanent = error instanceof SendError && error.permanent;
        console.error(JSON.stringify({ type: "channel_send_failed", item: item.id, attempts, permanent, error: errorText(error) }));
        if (permanent || attempts >= MAX_ATTEMPTS) return this.finish(item);
        const delay = Math.max(this.retryDelay(attempts - 1), error instanceof SendError ? error.retryAfterMs ?? 0 : 0);
        await this.save(item, version, { attempts, claim: undefined, due: Date.now() + delay });
        return;
      }
      // Progress is durable per part, so a retry resumes after the last part sent.
      ({ item, version } = await this.save(item, version, { sent: index + 1, claim: { node: this.options.node, until: Date.now() + CLAIM_MS } }));
    }
    await this.finish(item);
  }

  /** Queue a message to a conversation and try to send it now. */
  private async enqueue(binding: Binding, id: string, text: string) {
    const now = Date.now();
    const item: Item = {
      id, channel: binding.channel, tenant: binding.tenant, conversationId: binding.conversationId, createdAt: now,
      state: "sending", text, sent: 0, attempts: 0, due: now, claim: { node: this.options.node, until: now + CLAIM_MS },
    };
    let version: string;
    try { version = await this.storage.writeJson(itemKey(id), item, null); }
    catch (error) { if (error instanceof PreconditionFailed) return; throw error; }
    const channel = await this.read(binding.channel);
    if (!channel) return this.finish(item);
    await this.deliver(channel, item, version).catch(error => this.failed(item, error));
  }

  /** Count one event in a window, across nodes; returns the new count. */
  private async count(name: string) {
    const key = `channel-counts/${name}`;
    for (let attempt = 0; attempt < 20; attempt++) {
      const stored = await this.storage.readJson<{ count: number }>(key);
      const count = (stored?.value.count ?? 0) + 1;
      try { await this.storage.writeJson(key, { count }, stored?.version ?? null); return count; }
      catch (error) { if (!(error instanceof PreconditionFailed)) throw error; await sleep(Math.random() * 20); }
    }
    throw new Error("Counter contention");
  }

  /** The conversation's agent, created on first contact (and again if it expired or was deleted). */
  private async agentFor(channel: Channel, conversationId: string, sender: Sender) {
    const key = `channel-conversations/${channel.id}/${conversationId}`;
    const stored = (await this.storage.readJson<{ agent: string; generation: number }>(key))?.value;
    if (stored && await this.options.live(stored.agent, channel.tenant)) return stored.agent;
    const generation = stored ? stored.generation + 1 : 0;
    const label = sender.username ? `@${sender.username}` : sender.name ?? sender.id;
    const params = {
      ...channel.template, tools: [...channel.template.tools ?? [], SEND_MESSAGE],
      name: `${this.provider(channel.type).label}: ${label}`.slice(0, 120), type: "channel",
      // A conversation outlives any session TTL: its agent lives until deleted (DELETE /v1/agents/:id).
      ttlSeconds: null,
    };
    const created = await this.options.createAgent(channel.tenant, params, `${channel.type}-${channel.id}-${conversationId}${generation ? `-${generation}` : ""}`);
    const binding: Binding = { channel: channel.id, tenant: channel.tenant, conversationId };
    await this.storage.writeJson(`channel-agents/${created.id}`, binding);
    this.bindings.set(created.id, Promise.resolve(binding));
    await this.storage.writeJson(key, { agent: created.id, generation });
    return created.id;
  }

  private binding(agent: string) {
    let binding = this.bindings.get(agent);
    if (!binding) {
      if (this.bindings.size > 10_000) this.bindings.clear();
      binding = this.storage.readJson<Binding>(`channel-agents/${agent}`).then(stored => stored?.value);
      binding.catch(() => this.bindings.delete(agent));
      this.bindings.set(agent, binding);
    }
    return binding;
  }

  // Agent hooks -----------------------------------------------------------------

  readonly hooks: SessionHooks = {
    runStarted: (agent, record) => {
      if (record.method !== "prompt") return;
      void this.binding(agent.id).then(async binding => {
        const channel = binding && await this.read(binding.channel);
        if (!binding || !channel || this.typing.has(agent.id)) return;
        const { credentials } = this.secrets(channel);
        const provider = this.provider(channel.type);
        const show = () => void provider.typing(credentials, binding.conversationId).catch(() => {});
        // The service clears the indicator after a few seconds; keep it up while the turn runs.
        const timer = setInterval(show, TYPING_MS);
        timer.unref();
        this.typing.set(agent.id, timer);
        setTimeout(() => this.stopTyping(agent.id, timer), 10 * 60_000).unref();
        show();
      }).catch(() => {});
    },
    runEnded: (agent, record) => {
      this.stopTyping(agent.id);
      if (record.method !== "prompt") return;
      void this.settle(agent, record).catch(error => console.error(JSON.stringify({ type: "channel_reply_failed", agent: agent.id, request: record.id, error: errorText(error) })));
    },
    tool: async (agent, name, args) => {
      if (name !== SEND_MESSAGE.name) return undefined;
      const binding = await this.binding(agent.id);
      if (!binding) return undefined;
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) throw new Error("send_message needs text");
      await this.enqueue(binding, `msg_${randomUUID().replaceAll("-", "")}`, text);
      return { result: { sent: true } };
    },
    origin: async (agent, requestId) => {
      const binding = await this.binding(agent.id);
      if (!binding) return undefined;
      const channel = await this.read(binding.channel);
      const item = requestId?.startsWith("in_") ? (await this.storage.readJson<Item>(itemKey(requestId)))?.value : undefined;
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

  /** A channel agent's turn ended: its reply goes to the conversation. */
  private async settle(agent: AgentRef, record: RequestRecord) {
    const binding = await this.binding(agent.id);
    if (!binding) return;
    const text = replyText(record);
    if (!record.id.startsWith("in_")) {
      // Turns not started by a message (schedules, the API) reply to the conversation too.
      if (text) await this.enqueue(binding, `out_${sha(`${agent.id}:${record.id}`).slice(0, 40)}`, text);
      return;
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const stored = await this.storage.readJson<Item>(itemKey(record.id));
      if (!stored || stored.value.state !== "submitted" || stored.value.agent !== agent.id) return;
      if (!text) return this.finish(stored.value);
      let next;
      try { next = await this.save(stored.value, stored.version, { state: "sending", text, sent: 0, attempts: 0, due: Date.now(), claim: { node: this.options.node, until: Date.now() + CLAIM_MS } }); }
      catch (error) { if (error instanceof PreconditionFailed) continue; throw error; }
      const channel = await this.read(binding.channel);
      if (!channel) return this.finish(next.item);
      return this.deliver(channel, next.item, next.version).catch(error => this.failed(next.item, error));
    }
  }
}

/** What a finished prompt says back: the final answer, or an apology when the turn failed. */
function replyText(record: RequestRecord) {
  const outcome = record.outcome;
  if (!outcome || outcome.error !== undefined) return FAILED_REPLY;
  const result = outcome.result as { reply?: string; error?: string | null } | undefined;
  if (result?.error) return FAILED_REPLY;
  return result?.reply ?? "";
}
