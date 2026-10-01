import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ApplyResult } from "./definitions.ts";
import type { ConsoleAuth } from "./console-auth.ts";
import { discord, parseMessage } from "./channels-discord.ts";
import { SendError, type Channel, type ChannelInput, type ChannelProvider, type Channels, type Gateway } from "./channels.ts";
import { transaction, type Db } from "./db.ts";
import { HttpError, readJson } from "./http.ts";
import { managedBuiltinsRefusal } from "./builtins.ts";
import { underClaim, type Claim, type Ownership } from "./ownership.ts";

const ID = /^\d{1,20}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** View Channel, Send Messages, Send Messages in Threads, Attach Files and Read Message History; never Administrator. */
export const BOT_PERMISSIONS = "274878008320";
const snowflake = z.string().regex(ID, "Expected a Discord ID");
const channelIds = z.array(snowflake).min(1).max(100).transform(ids => [...new Set(ids)]);
const inputSchema = z.object({
  definition: z.string().min(1).optional(), name: z.string().min(1).max(120).optional(),
  allowedChannelIds: channelIds.optional(),
  access: z.object({ public: z.boolean().optional(), allow: z.array(z.string().min(1).max(100)).max(100).optional() }).strict().optional(),
  limits: z.object({ perSenderPerMinute: z.number().int().min(1).max(100).optional(), turnsPerDay: z.number().int().min(1).max(10_000).optional() }).strict().optional(),
  state: z.enum(["active", "paused", "disconnected"]).optional(),
}).strict();
type Binding = {
  id: string; application_id: string; guild_id: string; tenant: string; channel_id: string | null;
  state: "active" | "paused" | "disconnected"; allowed_channel_ids: string[];
  administrator_id: string; created_at: number; updated_at: number;
  installation_state?: "present" | "unavailable" | "removed"; guild_name?: string;
};
export interface ManagedDiscordOptions {
  db: Db; consoleAuth: ConsoleAuth; channels: () => Channels | undefined;
  ownership?: Ownership; node: string; publicUrl: string;
  botToken: string; applicationId: string; clientSecret: string; apiUrl?: string;
  canStart?: (tenant: string) => Promise<string | HttpError | undefined>;
  /** The builtins of a tenant's definition, to refuse self-starting ones for a server. */
  definitionBuiltins?: (tenant: string, definition: string) => Promise<string[] | undefined>;
  /** Builtins of a tenant's definition it cannot use (no key for them), as warnings for the setup's answer. */
  definitionWarnings?: (tenant: string, definition: string) => Promise<string[]>;
  /** How many servers the account may connect, and its highest daily turn limit per server. */
  plan?: (tenant: string) => Promise<{ free: boolean; servers: number; turnsPerDay: number }>;
  applyDefinition?: (tenant: string, channel: string, definition: string) => Promise<ApplyResult[]>;
}

/** A bounded round-robin queue shared by all guilds on this node; a global 429 holds all of it. */
class DiscordRestQueue {
  private queues = new Map<string, { work: () => Promise<unknown>; resolve: (value: any) => void; reject: (reason: unknown) => void }[]>();
  private running = false;
  private blockedUntil = 0;
  get size() { return [...this.queues.values()].reduce((n, jobs) => n + jobs.length, 0); }
  run<T>(guild: string, work: () => Promise<T>): Promise<T> {
    if (this.size >= 1000) return Promise.reject(new SendError("Managed Discord outbound queue is full", false, 1000));
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(guild) ?? [];
      queue.push({ work, resolve, reject }); this.queues.set(guild, queue);
      void this.pump();
    });
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queues.size) {
        const key = this.queues.keys().next().value!;
        const queue = this.queues.get(key)!;
        const job = queue.shift()!;
        this.queues.delete(key); if (queue.length) this.queues.set(key, queue);
        while (this.blockedUntil > Date.now()) await new Promise(resolve => setTimeout(resolve, Math.min(30_000, this.blockedUntil - Date.now())));
        try { job.resolve(await job.work()); }
        catch (error) {
          if (error instanceof SendError && error.global && error.retryAfterMs) this.blockedUntil = Math.max(this.blockedUntil, Date.now() + error.retryAfterMs);
          job.reject(error);
        }
      }
    } finally { this.running = false; }
  }
}

/** The platform credential lives here, never in a channel. One application Gateway routes verified guilds. */
export class ManagedDiscord {
  readonly app: Hono;
  readonly provider: ChannelProvider;
  private readonly base: string;
  private readonly transport: ChannelProvider;
  private readonly queue = new DiscordRestQueue();
  private gateway?: Gateway;
  private claim?: Claim;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private reconciling = false;
  private dispatchTail: Promise<void> = Promise.resolve();
  private dispatchBacklog = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private botId = "";
  private readonly options: ManagedDiscordOptions;
  constructor(options: ManagedDiscordOptions) {
    this.options = options;
    this.base = (options.apiUrl ?? "https://discord.com/api/v10").replace(/\/+$/, "");
    this.transport = discord({ apiUrl: this.base, gateway: {
      // GUILDS and GUILD_MESSAGES: Camel answers only in servers, when mentioned.
      intents: (1 << 0) | (1 << 9),
      dispatch: (event, data) => {
        // GUILD_MESSAGES delivers every message in every server: only mentions are queued, and the queue is bounded.
        if (event === "READY") this.botId = String(data?.user?.id ?? "");
        else if (event === "MESSAGE_CREATE" && (!data?.guild_id || !data.mentions?.some((user: any) => user?.id === this.botId))) return;
        else if (!["MESSAGE_CREATE", "GUILD_CREATE", "GUILD_UPDATE", "GUILD_DELETE"].includes(event)) return;
        if (this.dispatchBacklog >= 1000) { this.log("dispatch_dropped", { event }); return; }
        this.dispatchBacklog++;
        this.dispatchTail = this.dispatchTail.then(() => this.dispatch(event, data)).catch(error => this.log("dispatch_failed", { error: error instanceof HttpError ? error.code ?? `HTTP_${error.status}` : "processing_failed" }))
          .finally(() => { this.dispatchBacklog--; });
        return this.dispatchTail;
      },
    } });
    const credentials = { botToken: options.botToken };
    const delivery = async <T>(given: Record<string, string>, conversation: string, work: () => Promise<T>) => {
      const binding = await this.byId(given.bindingId);
      if (!binding) throw new SendError("Managed Discord binding is unavailable", true);
      return this.scheduled(binding.guild_id, async () => {
        if (!await this.destination(binding.id, conversation)) throw new SendError("Managed Discord destination is unavailable or not permitted", true);
        return work();
      });
    };
    this.provider = {
      label: "Camel Discord", managed: true, needsCredentials: false,
      // One bot speaks for every server, so its typing indicator is refreshed less often and never waits in line.
      maxMessageLength: this.transport.maxMessageLength, maxFileBytes: this.transport.maxFileBytes, typingMs: 30_000,
      defaults: { access: { public: false }, limits: { perSenderPerMinute: 5, turnsPerDay: 100 } },
      // Only server setup creates these channels (Channels refuses `managed` providers otherwise), inside its own transaction.
      setup: async given => {
        if (typeof given.bindingId !== "string" || !ID.test(given.guildId ?? "")) throw new HttpError(403, "Add Camel to a Discord server from the console");
        return { account: { id: options.applicationId, guildId: given.guildId, username: "Camel" }, masked: {} };
      },
      teardown: async () => {},
      guard: async (channel, conversation, phase) => {
        const binding = await this.byChannel(channel.id);
        if (!binding || binding.tenant !== channel.tenant || !await this.destination(binding.id, conversation)) return false;
        return phase !== "submit" || !await options.canStart?.(binding.tenant);
      },
      download: (given, file) => this.transport.download(credentials, file),
      send: (given, conversation, content) => delivery(given, conversation, () => this.transport.send(credentials, conversation, content)),
      sendFile: (given, conversation, file, caption) => delivery(given, conversation, () => this.transport.sendFile(credentials, conversation, file, caption)),
      typing: async (given, conversation) => { if (!this.queue.size) await delivery(given, conversation, () => this.transport.typing!(credentials, conversation)); },
    };
    this.app = this.routes();
    options.ownership?.onFence(() => { this.gateway?.close(); this.gateway = undefined; this.claim = undefined; });
  }

  private log(event: string, fields: Record<string, unknown> = {}) {
    console.log(JSON.stringify({ type: `discord_managed_${event}`, ...fields }));
  }
  private channels() { const channels = this.options.channels(); if (!channels) throw new HttpError(503, "Channels are not available"); return channels; }
  private scheduled<T>(guild: string, work: () => Promise<T>): Promise<T> {
    return this.queue.run(guild, async () => {
      await this.cooldown();
      try { return await work(); }
      catch (error) { await this.limited(error); throw error; }
    });
  }
  /** A global Discord rate limit, which any node may have hit, holds every node's requests. */
  private async cooldown() {
    const row = (await this.options.db.query("select until_at from discord_setup_cooldowns where key=$1", [`${this.options.applicationId}:rest`])).rows[0];
    if (row?.until_at > Date.now()) throw new SendError("Discord global delivery cooldown", false, Number(row.until_at) - Date.now(), true);
  }
  /** Only a global 429 is shared; a route's own limit just delays the item that met it. */
  private async limited(error: unknown) {
    if (!(error instanceof SendError) || !error.global || !error.retryAfterMs) return;
    await this.options.db.query(`insert into discord_setup_cooldowns (key,until_at) values ($1,$2) on conflict (key) do update set until_at=greatest(discord_setup_cooldowns.until_at,excluded.until_at)`, [`${this.options.applicationId}:rest`, Date.now() + error.retryAfterMs]);
  }
  private async bot(path: string, method: "GET" | "DELETE" = "GET") {
    await this.cooldown();
    const response = await fetch(`${this.base}${path}`, { method, headers: { Authorization: `Bot ${this.options.botToken}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      if (response.status === 429) {
        const body = await response.json().catch(() => ({})) as any;
        const global = body.global === true || response.headers.get("x-ratelimit-global") === "true" || response.headers.get("x-ratelimit-scope") === "global";
        const error = new SendError("Discord is rate limiting managed requests", false, Math.max(1000, Number(body.retry_after ?? 1) * 1000), global);
        await this.limited(error);
        throw error;
      }
      throw new HttpError(response.status === 404 ? 404 : 502, response.status === 404 ? "Camel is not installed or cannot access this Discord destination" : `Discord request failed (HTTP ${response.status})`);
    }
    return response.status === 204 ? {} : response.json() as Promise<any>;
  }
  private async byId(id: string | undefined): Promise<Binding | undefined> {
    if (!id) return undefined;
    return (await this.options.db.query(`select b.*, i.state installation_state, i.name guild_name from discord_server_bindings b join discord_installations i using (application_id,guild_id) where b.id=$1 and b.application_id=$2`, [id, this.options.applicationId])).rows[0];
  }
  private async byGuild(guild: string, sql: Pick<Db, "query"> = this.options.db): Promise<Binding | undefined> {
    return (await sql.query(`select b.*, i.state installation_state, i.name guild_name from discord_server_bindings b join discord_installations i using (application_id,guild_id) where b.guild_id=$1 and b.application_id=$2`, [guild, this.options.applicationId])).rows[0];
  }
  private async byChannel(channel: string): Promise<Binding | undefined> {
    return (await this.options.db.query(`select b.*, i.state installation_state, i.name guild_name from discord_server_bindings b join discord_installations i using (application_id,guild_id) where b.channel_id=$1 and b.application_id=$2`, [channel, this.options.applicationId])).rows[0];
  }
  private async destination(bindingId: string, channelId: string) {
    if (!ID.test(channelId)) return false;
    let binding = await this.byId(bindingId);
    if (!binding || binding.state !== "active" || !binding.channel_id || binding.installation_state !== "present") return false;
    // An allowed channel was checked against this guild when it was saved, and a channel never changes guild: only threads need a lookup.
    if (binding.allowed_channel_ids.includes(channelId)) return true;
    let channel;
    try { channel = await this.bot(`/channels/${channelId}`); }
    catch (error) { if (error instanceof HttpError && error.status === 404) return false; throw error; }
    if (channel.guild_id !== binding.guild_id || !binding.allowed_channel_ids.some(id => id === channelId || (id === channel.parent_id && [10, 11, 12].includes(channel.type)))) return false;
    // Re-read after the REST request: pause, removal and configuration races must not use a cached grant.
    binding = await this.byId(bindingId);
    return !!binding && binding.state === "active" && !!binding.channel_id && binding.installation_state === "present" && binding.allowed_channel_ids.some(id => id === channelId || (id === channel.parent_id && [10, 11, 12].includes(channel.type)));
  }

  /** Operators enable this only for an application Discord permits to use a single shard. */
  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.maintain().catch(() => this.log("gateway_retry_failed"));
    if (this.stopped) return;
    this.timer = setInterval(() => void this.maintain().catch(() => this.log("gateway_retry_failed")), 10_000);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.gateway?.close(); this.gateway = undefined;
    const claim = this.claim; this.claim = undefined;
    if (claim) await this.options.ownership?.release(claim);
  }
  private async maintain() {
    if (this.stopped) return;
    const now = Date.now();
    await this.options.db.query("delete from discord_setup_attempts where expires_at<=$1", [now]);
    await this.options.db.query("delete from discord_setup_cooldowns where until_at<$1", [now - 24 * 60 * 60_000]);
    await this.reconcileGateway();
  }
  private async reconcileGateway() {
    if (this.stopped || this.reconciling || this.gateway) return;
    this.reconciling = true;
    try {
      if (this.options.ownership) {
        const acquired = await this.options.ownership.acquire(`discord-managed:${this.options.applicationId}:shard:0`);
        if (!("claim" in acquired)) return;
        if (this.stopped) { await this.options.ownership.release(acquired.claim); return; }
        this.claim = acquired.claim;
      }
      const gateway = await this.bot("/gateway/bot");
      if (this.stopped || !this.current()) return;
      if (Number(gateway.shards ?? 1) !== 1) throw new HttpError(503, "Managed Discord pilot requires one shard; implement multi-shard coordination before enabling this application");
      if (gateway.session_start_limit?.remaining === 0) throw new HttpError(503, "Discord Gateway session-start allowance is exhausted");
      this.gateway = this.transport.connect!({ botToken: this.options.botToken }, {
        message: async () => {}, failed: () => { this.gateway = undefined; this.log("gateway_failed"); },
        diagnostic: (event, fields) => this.log(`gateway_${event}`, fields),
      });
    } catch (error) {
      const claim = this.claim; this.claim = undefined;
      if (claim) await this.options.ownership?.release(claim);
      throw error;
    } finally { this.reconciling = false; }
  }

  private current() { return !this.options.ownership || (!!this.claim && this.options.ownership.holds(this.claim)); }
  /** Exported as an instance method to exercise real routing against a fake Gateway in integration tests. */
  async dispatch(event: string, data: any) {
    if (!this.current()) return;
    if (event === "READY") {
      this.botId = String(data.user?.id ?? "");
      const ids = (Array.isArray(data.guilds) ? data.guilds : []).filter((guild: any) => ID.test(guild?.id)).map((guild: any) => guild.id);
      await underClaim(this.options.db, this.claim, async sql => {
        await sql.query(`update discord_installations set state='removed',updated_at=$3 where application_id=$1 and guild_id<>all($2::text[])`, [this.options.applicationId, ids, Date.now()]);
        await sql.query(`update discord_server_bindings b set state='disconnected',updated_at=$2 from discord_installations i where b.application_id=i.application_id and b.guild_id=i.guild_id and i.application_id=$1 and i.state='removed' and b.state<>'disconnected'`, [this.options.applicationId, Date.now()]);
        await sql.query(`delete from channel_items where item->>'channel' in (select b.channel_id from discord_server_bindings b join discord_installations i using(application_id,guild_id) where b.application_id=$1 and i.state='removed')`, [this.options.applicationId]);
      });
      // READY lists every guild as unavailable until its GUILD_CREATE: that is not an outage, so a present server stays present.
      for (const guild of data.guilds ?? []) if (ID.test(guild?.id)) await this.installation(guild.id, guild.name ?? "", guild.unavailable ? "unavailable" : "present", true);
      return;
    }
    if (event === "GUILD_CREATE" || event === "GUILD_UPDATE") {
      if (ID.test(data?.id)) await this.installation(data.id, data.name ?? "", data.unavailable ? "unavailable" : "present");
      return;
    }
    if (event === "GUILD_DELETE") {
      if (ID.test(data?.id)) await this.installation(data.id, "", data.unavailable ? "unavailable" : "removed");
      return;
    }
    if (event !== "MESSAGE_CREATE" || !this.botId || !data?.author || data.author.bot || data.webhook_id || !ID.test(data.channel_id) || !ID.test(data.id) || ![0, 19].includes(data.type)) return;
    if (!ID.test(data.guild_id ?? "") || !data.mentions?.some((user: any) => user?.id === this.botId)) return;
    const binding = await this.byGuild(data.guild_id);
    // In a server nobody added through the console (a hand-made invite, or an install whose setup failed), Camel leaves.
    if (!binding) {
      this.log("unbound_server_left", { guildId: data.guild_id });
      void this.scheduled(data.guild_id, () => this.bot(`/users/@me/guilds/${data.guild_id}`, "DELETE")).catch(() => this.log("leave_failed"));
      return;
    }
    // Being set up, paused, disconnected or unavailable: the console says so; the server is not answered.
    if (binding.state !== "active" || !binding.channel_id || binding.installation_state !== "present") return;
    const inbound = parseMessage(data, this.botId);
    if (!inbound) return;
    const channel = await this.channels().get(binding.tenant, binding.channel_id!).catch(() => undefined);
    if (!channel || !this.channels().allowed(channel, inbound.sender)) return;
    if (!await this.destination(binding.id, data.channel_id)) return;
    if (await this.options.canStart?.(binding.tenant)) {
      await this.status(data.channel_id, data.guild_id, "Camel cannot start work for this server right now. A server admin can check the account's balance and spending limits in the console.");
      return;
    }
    if (this.current()) await this.channels().inbound(binding.channel_id!, inbound);
  }
  private async installation(guild: string, name: string, state: "present" | "unavailable" | "removed", ready = false) {
    if (!this.current()) return;
    await underClaim(this.options.db, this.claim, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`discord-binding:${this.options.applicationId}:${guild}`]);
      const prior = (await sql.query(`select state from discord_installations where application_id=$1 and guild_id=$2 for update`, [this.options.applicationId, guild])).rows[0];
      await sql.query(`insert into discord_installations (application_id,guild_id,name,state,updated_at) values ($1,$2,$3,$4,$5) on conflict (application_id,guild_id) do update set name=case when excluded.name='' then discord_installations.name else excluded.name end,state=case when $6 and discord_installations.state='present' then 'present' else excluded.state end,updated_at=excluded.updated_at`, [this.options.applicationId, guild, name, state, Date.now(), ready]);
      // Removing the bot disconnects the server: reactivating it is explicit, and any verified administrator may set it up again.
      if (state === "removed" || prior?.state === "removed") {
        await sql.query(`update discord_server_bindings set state='disconnected',updated_at=$3 where application_id=$1 and guild_id=$2 and state<>'disconnected'`, [this.options.applicationId, guild, Date.now()]);
        await sql.query(`delete from channel_items where item->>'channel' in (select channel_id from discord_server_bindings where application_id=$1 and guild_id=$2)`, [this.options.applicationId, guild]);
      }
    });
  }
  /** At most one status reply a minute in a channel, for a configured server only. */
  private async status(channel: string, guild: string, content: string) {
    if (!this.current()) return;
    const allowed = await underClaim(this.options.db, this.claim, async sql => {
      const now = Date.now();
      const local = await sql.query(`insert into discord_setup_cooldowns (key,until_at) values ($1,$2) on conflict (key) do update set until_at=excluded.until_at,count=1 where discord_setup_cooldowns.until_at<=$3 returning key`, [`${this.options.applicationId}:${guild}:${channel}`, now + 60_000, now]);
      return !!local.rowCount;
    });
    if (allowed) void this.scheduled(guild, async () => {
      if (this.current()) await this.transport.send({ botToken: this.options.botToken }, channel, content);
    }).catch(() => this.log("status_failed"));
  }

  private session(req: Request) { return hash((req.headers.get("cookie") ?? "").split(";").map(value => value.trim()).find(value => value.startsWith("ar_session=")) ?? ""); }
  private async verifiedInstallation(guildId: string) {
    const guild = await this.bot(`/guilds/${guildId}`);
    if (guild.id !== guildId) throw new HttpError(403, "Camel is not installed in this server");
    // Console writes are not Gateway-owned; a later Gateway removal still fences all delivery.
    await this.options.db.query(`insert into discord_installations (application_id,guild_id,name,state,updated_at) values ($1,$2,$3,'present',$4) on conflict (application_id,guild_id) do update set name=excluded.name,state='present',updated_at=excluded.updated_at`, [this.options.applicationId, guildId, guild.name ?? "", Date.now()]);
    return guild;
  }
  /** Whether a user owns the server or holds Administrator or Manage Server there, read with the bot token (roles only; no member intent needed). */
  private async manages(server: { id: string; owner_id?: string; roles?: { id: string; permissions?: string }[] }, user: string) {
    if (server.owner_id === user) return true;
    let member;
    try { member = await this.bot(`/guilds/${server.id}/members/${user}`); }
    catch (error) { if (error instanceof HttpError && error.status === 404) return false; throw error; }
    const held = new Set([server.id, ...(Array.isArray(member.roles) ? member.roles : [])]);
    const permissions = (server.roles ?? []).filter(role => held.has(role.id)).reduce((bits, role) => bits | (/^\d+$/.test(role.permissions ?? "") ? BigInt(role.permissions!) : 0n), 0n);
    return (permissions & ((1n << 3n) | (1n << 5n))) !== 0n;
  }
  private async validateChannels(guildId: string, ids: string[]) {
    for (const id of ids) {
      const channel = await this.bot(`/channels/${id}`);
      if (channel.guild_id !== guildId || ![0, 5, 10, 11, 12, 15, 16].includes(channel.type)) throw new HttpError(400, "Allowed channels must be message channels or threads in this Discord server");
    }
  }
  /** One server's binding and channel writes commit together. At most one mutation connection per node: Channels shares the pool. */
  private withBindingLock<T>(guild: string, work: (sql: Pick<Db, "query">) => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(() => transaction(this.options.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`discord-binding:${this.options.applicationId}:${guild}`]);
      return work(sql);
    }));
    this.mutationTail = result.then(() => {}, () => {});
    return result;
  }
  /** The previous account's channel goes, so its agents keep their history but see no new conversation. */
  private async release(binding: Binding, sql: Pick<Db, "query">) {
    if (binding.channel_id) {
      for (const table of ["channel_items"]) await sql.query(`delete from ${table} where item->>'channel'=$1`, [binding.channel_id]);
      for (const table of ["channel_agents", "channel_conversations", "channel_seen", "channel_counts"]) await sql.query(`delete from ${table} where channel=$1`, [binding.channel_id]);
      await sql.query("delete from channels where id=$1 and tenant=$2", [binding.channel_id, binding.tenant]);
    }
  }
  /** Servers per account, and the daily turn ceiling, by plan (operators can override the server count per tenant). */
  private async checkLimits(tenant: string, limits?: { turnsPerDay?: number }) {
    const plan = await this.plan(tenant);
    if (limits?.turnsPerDay !== undefined && limits.turnsPerDay > plan.turnsPerDay) throw new HttpError(400, `Turns per server per day can be at most ${plan.turnsPerDay} on this account${plan.free ? " while it is on free credit" : ""}`);
  }
  private async checkDefinition(tenant: string, definition: string) {
    const refusal = managedBuiltinsRefusal(await this.options.definitionBuiltins?.(tenant, definition));
    if (refusal) throw new HttpError(400, refusal);
  }
  private async checkServers(tenant: string, sql: Pick<Db, "query">, guild: string) {
    const plan = await this.plan(tenant);
    const { rows } = await sql.query("select count(*)::int n from discord_server_bindings where tenant=$1 and application_id=$2 and guild_id<>$3 and state<>'disconnected'", [tenant, this.options.applicationId, guild]);
    if (rows[0].n >= plan.servers) throw new HttpError(409, `This account can connect at most ${plan.servers} Discord server${plan.servers === 1 ? "" : "s"}${plan.free ? " while it is on free credit" : ""}; disconnect one first`);
  }
  private async plan(tenant: string) {
    return await this.options.plan?.(tenant) ?? { free: false, servers: 10, turnsPerDay: 10_000 };
  }
  private async view(binding: Binding) {
    return {
      guildId: binding.guild_id, guildName: binding.guild_name ?? "", state: binding.state,
      installationState: binding.installation_state, channelId: binding.channel_id, allowedChannelIds: binding.allowed_channel_ids,
      ...(binding.channel_id ? { channel: await this.channels().get(binding.tenant, binding.channel_id) } : {}),
    };
  }
  /**
   * Bind a server to the account whose administrator just added Camel to it. Discord adds a bot only for a user
   * with Manage Server there, so the token exchange's `guild` is the proof. A server bound to another account
   * moves only once that binding is disconnected (removing Camel from the server disconnects it).
   */
  private async bind(tenant: string, guild: string, administrator: string) {
    let leave = false;
    try {
      await this.withBindingLock(guild, async sql => {
        const now = Date.now();
        const binding = await this.byGuild(guild, sql);
        if (binding && binding.tenant !== tenant && binding.state !== "disconnected") throw new HttpError(409, "This Discord server is connected to another camelRun account. A server administrator can remove Camel from the server, then add it again from this account");
        if (binding?.state === "disconnected" || !binding) {
          try { await this.checkServers(tenant, sql, guild); }
          catch (error) { leave = !binding; throw error; }
        }
        if (!binding) {
          await sql.query(`insert into discord_server_bindings (id,application_id,guild_id,tenant,state,allowed_channel_ids,administrator_id,created_at,updated_at) values ($1,$2,$3,$4,'paused','[]',$5,$6,$6)`, [randomUUID(), this.options.applicationId, guild, tenant, administrator, now]);
        } else if (binding.tenant !== tenant) {
          await this.release(binding, sql);
          await sql.query("update discord_server_bindings set tenant=$2,channel_id=null,state='paused',allowed_channel_ids='[]',administrator_id=$3,updated_at=$4 where id=$1", [binding.id, tenant, administrator, now]);
          this.log("binding_taken_over", { guildId: guild, from: binding.tenant, tenant });
        } else {
          // Added again by its own account: a disconnected server comes back paused, to be resumed explicitly.
          await sql.query("update discord_server_bindings set administrator_id=$2,state=case when state='disconnected' then 'paused' else state end,updated_at=$3 where id=$1", [binding.id, administrator, now]);
        }
      });
    } finally {
      if (leave) void this.scheduled(guild, () => this.bot(`/users/@me/guilds/${guild}`, "DELETE")).catch(() => this.log("leave_failed"));
    }
    this.log("binding_created", { guildId: guild, tenant });
  }
  private installUrl(state: string, guild?: string) {
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", this.options.applicationId);
    url.searchParams.set("scope", "bot identify");
    url.searchParams.set("permissions", BOT_PERMISSIONS);
    url.searchParams.set("integration_type", "0");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", new URL("/console/discord/callback", this.options.publicUrl).href);
    url.searchParams.set("state", state);
    if (guild) { url.searchParams.set("guild_id", guild); url.searchParams.set("disable_guild_select", "true"); }
    return url.href;
  }
  private routes() {
    const app = new Hono();
    app.use("/console/discord/*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      const principal = await this.options.consoleAuth.principal(c.req.raw);
      if (!principal) {
        // Adding Camel starts here before sign-in too (Discord's Install Link): sign in, then come back.
        if (c.req.path === "/console/discord/install") {
          const guild = c.req.query("guild_id");
          return c.redirect(`/console/channels?discord_install=1${guild && ID.test(guild) ? `&guild_id=${guild}` : ""}`);
        }
        if (c.req.path === "/console/discord/callback") return c.redirect("/console/channels?discord_error=" + encodeURIComponent("Sign in to camelRun, then add Camel to Discord again"));
        return c.json({ error: "Sign in to the Camel console" }, 401);
      }
      if (c.req.method !== "GET" && !this.options.consoleAuth.allowsMutation(c.req.raw)) return c.json({ error: "Use a same-origin console request" }, 403);
      c.set("tenant" as never, principal.tenant as never);
      await next();
    });
    const tenant = (c: any): string => c.get("tenant");
    app.get("/console/discord/config", async c => {
      const plan = await this.plan(tenant(c));
      return c.json({ enabled: true, applicationId: this.options.applicationId, installPath: "/console/discord/install", limits: { servers: plan.servers, turnsPerDay: plan.turnsPerDay } });
    });
    // One Discord authorization adds the bot and proves the user manages the server. The state is single use and bound to this console session.
    app.get("/console/discord/install", async c => {
      const guild = c.req.query("guild_id");
      const state = randomBytes(32).toString("base64url"); const now = Date.now();
      await this.options.db.query("delete from discord_setup_attempts where expires_at<$1", [now]);
      await this.options.db.query("insert into discord_setup_attempts (state_hash,tenant,session_hash,guild_id,expires_at) values ($1,$2,$3,$4,$5)", [hash(state), tenant(c), this.session(c.req.raw), guild && ID.test(guild) ? guild : null, now + 10 * 60_000]);
      return c.redirect(this.installUrl(state, guild && ID.test(guild) ? guild : undefined));
    });
    app.get("/console/discord/callback", async c => {
      const state = c.req.query("state") ?? "";
      const done = new URL("/console/channels", this.options.publicUrl);
      // What a failed install saw, for the log: never a token or code.
      const seen: Record<string, unknown> = { hint: ID.test(c.req.query("guild_id") ?? "") };
      try {
        const attempt = (await this.options.db.query("delete from discord_setup_attempts where state_hash=$1 and tenant=$2 and session_hash=$3 and expires_at>$4 returning *", [hash(state), tenant(c), this.session(c.req.raw), Date.now()])).rows[0];
        if (!attempt || !state) throw new HttpError(400, "This Discord authorization expired or was started from another session; add Camel to Discord again");
        if (c.req.query("error")) throw new HttpError(400, "Discord authorization was cancelled");
        const code = c.req.query("code"); if (!code) throw new HttpError(400, "Discord authorization did not return a code");
        const response = await fetch(`${this.base}/oauth2/token`, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: this.options.applicationId, client_secret: this.options.clientSecret, grant_type: "authorization_code", code, redirect_uri: new URL("/console/discord/callback", this.options.publicUrl).href }), signal: AbortSignal.timeout(15_000),
        });
        seen.exchange = response.status;
        if (!response.ok) throw new HttpError(403, "Discord could not verify the authorization; add Camel to Discord again");
        const grant = await response.json().catch(() => ({})) as any;
        Object.assign(seen, { fields: Object.keys(grant ?? {}).sort(), scope: typeof grant?.scope === "string" ? grant.scope : null, guild: ID.test(String(grant?.guild?.id ?? "")) });
        // The token response's guild is Discord's word on where the bot went. Its `scope` lists the user token's scopes, not reliably `bot`, so it is not checked.
        // Without a guild, the redirect's guild_id is only a hint: the bot must be there, and this user must manage that server (checked below with the bot token).
        const attested = ID.test(String(grant?.guild?.id ?? "")) ? String(grant.guild.id) : undefined;
        const guild = attested ?? (ID.test(c.req.query("guild_id") ?? "") ? c.req.query("guild_id")! : "");
        if (typeof grant?.access_token !== "string" || !ID.test(guild)) throw new HttpError(400, "Discord did not add Camel to a server; choose a server and try again");
        if (attempt.guild_id && attempt.guild_id !== guild) throw new HttpError(400, "Camel was added to a different server than the one chosen; try again");
        const me = await fetch(`${this.base}/users/@me`, { headers: { Authorization: `Bearer ${grant.access_token}` }, signal: AbortSignal.timeout(15_000) }).then(answer => answer.ok ? answer.json() as Promise<any> : undefined, () => undefined);
        if (!ID.test(me?.id ?? "")) throw new HttpError(403, "Discord could not verify your identity");
        // With Requires OAuth2 Code Grant on, the bot joins as the code is exchanged: give Discord a moment to show it.
        let server: any;
        for (let tries = 0; ; tries++) {
          try { server = await this.verifiedInstallation(guild); break; }
          catch (error) { if (tries >= 2 || !(error instanceof HttpError && error.status === 404)) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
        }
        if (!attested && !await this.manages(server, me.id)) throw new HttpError(403, "You must own this Discord server or have Manage Server permission in it");
        await this.bind(tenant(c), guild, me.id);
        done.searchParams.set("discord_server", guild);
      } catch (error) {
        const message = error instanceof HttpError ? error.message : "Adding Camel to Discord failed; try again";
        this.log("install_failed", { tenant: tenant(c), reason: message, ...seen });
        done.searchParams.set("discord_error", message);
      }
      return c.redirect(done.href);
    });
    app.get("/console/discord/bindings", async c => {
      const bindings = (await this.options.db.query(`select b.*,i.state installation_state,i.name guild_name from discord_server_bindings b join discord_installations i using(application_id,guild_id) where b.application_id=$1 and b.tenant=$2 order by b.created_at`, [this.options.applicationId, tenant(c)])).rows as Binding[];
      return c.json({ bindings: await Promise.all(bindings.map(binding => this.view(binding))) });
    });
    app.get("/console/discord/guilds/:guildId/channels", async c => {
      const guildId = c.req.param("guildId");
      const binding = ID.test(guildId) ? await this.byGuild(guildId) : undefined;
      if (!binding || binding.tenant !== tenant(c)) throw new HttpError(404, "Discord server binding not found");
      const channels = await this.bot(`/guilds/${guildId}/channels`);
      return c.json({ channels: channels.filter((channel: any) => [0, 5, 15, 16].includes(channel.type)).map((channel: any) => ({ id: channel.id, name: channel.name, type: channel.type })) });
    });
    // The bound account configures, pauses, resumes and disconnects its server; Discord's own permissions decided who could bind it.
    app.patch("/console/discord/bindings/:guildId", async c => {
      const parsed = inputSchema.safeParse(await readJson(c.req.raw.body, 16_384));
      if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
      const input = parsed.data; const guildId = c.req.param("guildId"); const account = tenant(c);
      const current = ID.test(guildId) ? await this.byGuild(guildId) : undefined;
      if (!current || current.tenant !== account) throw new HttpError(404, "Discord server binding not found");
      const stopping = input.state === "paused" || input.state === "disconnected";
      const setup = !current.channel_id && !(stopping && Object.keys(input).length === 1);
      if (setup && (!input.definition || !input.allowedChannelIds)) throw new HttpError(400, "Choose a definition and allowed channels to finish setting up this server");
      await this.checkLimits(account, input.limits);
      if (input.definition) await this.checkDefinition(account, input.definition);
      // Discord is asked before the lock, so no database connection waits on it. Pause and disconnect work after the bot is removed.
      if (!stopping) await this.verifiedInstallation(guildId);
      if (input.allowedChannelIds) await this.validateChannels(guildId, input.allowedChannelIds);
      const channelId = await this.withBindingLock(guildId, async sql => {
        const binding = await this.byGuild(guildId, sql);
        if (!binding || binding.id !== current.id || binding.tenant !== account || binding.channel_id !== current.channel_id) throw new HttpError(409, "This server's setup changed meanwhile; reload and try again");
        const state = input.state ?? (setup ? "active" : binding.state);
        if (state !== "disconnected" && binding.state === "disconnected") await this.checkServers(account, sql, guildId);
        const fields: ChannelInput = { ...(input.definition ? { definition: input.definition } : {}), ...(input.name ? { name: input.name } : {}), ...(input.access ? { access: input.access } : {}), ...(input.limits ? { limits: input.limits } : {}) };
        let channelId = binding.channel_id;
        if (setup) channelId = (await this.channels().create(account, { type: "discord-managed", ...fields, name: input.name ?? `Camel · ${binding.guild_name || guildId}`, credentials: { bindingId: binding.id, guildId } }, { managed: true, sql })).id;
        else if (channelId && Object.keys(fields).length) await this.channels().update(account, channelId, fields, { managed: true, sql });
        await sql.query(`update discord_server_bindings set channel_id=$2,state=case when $3::text='active' and not exists (select 1 from discord_installations i where i.application_id=discord_server_bindings.application_id and i.guild_id=discord_server_bindings.guild_id and i.state='present') then 'paused' else $3 end,allowed_channel_ids=$4,updated_at=$5 where id=$1`, [binding.id, channelId, state, JSON.stringify(input.allowedChannelIds ?? binding.allowed_channel_ids), Date.now()]);
        // Only a stopped server's queued work is cancelled; every other change is rechecked as each item proceeds.
        if (state !== "active" && channelId) await sql.query("delete from channel_items where item->>'channel'=$1", [channelId]);
        return channelId;
      });
      this.log("binding_updated", { guildId, tenant: account, state: input.state, setup });
      const applied = !setup && channelId && input.definition && this.options.applyDefinition ? await this.options.applyDefinition(account, channelId, input.definition) : undefined;
      const warnings = input.definition ? await this.options.definitionWarnings?.(account, input.definition) ?? [] : [];
      return c.json({ ...await this.view((await this.byId(current.id))!), ...(applied ? { applied } : {}), ...(warnings.length ? { warnings } : {}) });
    });
    app.onError((error, c) => {
      const status = error instanceof HttpError ? error.status : error instanceof SendError ? 503 : error instanceof z.ZodError ? 400 : 500;
      return c.json({ error: status < 500 ? error.message : "Managed Discord request failed; try again" }, status as 400 | 403 | 404 | 409 | 500);
    });
    return app;
  }
}
