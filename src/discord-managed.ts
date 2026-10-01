import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ApplyResult } from "./definitions.ts";
import type { ConsoleAuth } from "./console-auth.ts";
import { discord, parseMessage } from "./channels-discord.ts";
import { SendError, type Channel, type ChannelInput, type ChannelProvider, type Channels, type Gateway } from "./channels.ts";
import { transaction, type Db } from "./db.ts";
import { HttpError, readJson, readText } from "./http.ts";
import { underClaim, type Claim, type Ownership } from "./ownership.ts";

const ID = /^\d{1,20}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const LINK_MS = 15 * 60_000;
const snowflake = z.string().regex(ID, "Expected a Discord ID");
const channelIds = z.array(snowflake).min(1).max(100).transform(ids => [...new Set(ids)]);
const inputSchema = z.object({
  definition: z.string().min(1).optional(), name: z.string().min(1).max(120).optional(),
  allowedChannelIds: channelIds.optional(),
  access: z.object({ public: z.boolean().optional(), allow: z.array(z.string().min(1).max(100)).max(100).optional() }).strict().optional(),
  limits: z.object({ perSenderPerMinute: z.number().int().min(1).max(100).optional(), turnsPerDay: z.number().int().min(1).max(10_000).optional() }).strict().optional(),
  state: z.enum(["active", "paused", "disconnected"]).optional(),
}).strict();
const createSchema = inputSchema.extend({ guildId: snowflake, definition: z.string().min(1), allowedChannelIds: channelIds });
type Binding = {
  id: string; application_id: string; guild_id: string; tenant: string; channel_id: string | null;
  state: "active" | "paused" | "disconnected"; allowed_channel_ids: string[];
  administrator_id: string; created_at: number; updated_at: number;
  installation_state?: "present" | "unavailable" | "removed"; guild_name?: string;
};
export interface ManagedDiscordOptions {
  db: Db; consoleAuth: ConsoleAuth; channels: () => Channels | undefined;
  ownership?: Ownership; node: string; publicUrl: string;
  botToken: string; applicationId: string; clientSecret: string; publicKey: string; apiUrl?: string;
  canStart?: (tenant: string) => Promise<string | HttpError | undefined>;
  applyDefinition?: (tenant: string, channel: string, definition: string) => Promise<ApplyResult[]>;
}

/** Check the permissions returned by Discord itself; callback/server URL parameters are never proof. */
export function managesGuild(guild: { owner?: boolean; permissions?: unknown }): boolean {
  if (guild.owner === true) return true;
  try {
    if (typeof guild.permissions !== "string" || !/^\d+$/.test(guild.permissions)) return false;
    return (BigInt(guild.permissions) & ((1n << 3n) | (1n << 5n))) !== 0n;
  } catch { return false; }
}

/** Exact raw-body verification with a bounded timestamp; no Discord REST call on the acknowledgement path. */
export function verifyInteraction(publicKey: string, headers: Headers, body: string, now = Date.now()): boolean {
  const signature = headers.get("x-signature-ed25519") ?? "";
  const timestamp = headers.get("x-signature-timestamp") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(publicKey) || !/^[a-f0-9]{128}$/i.test(signature) || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > 5 * 60_000) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, "hex"));
  } catch { return false; }
}

/** A bounded round-robin queue shared by all guilds on this node, with a conservative global 429 cooldown. */
class DiscordRestQueue {
  private queues = new Map<string, { work: () => Promise<unknown>; resolve: (value: any) => void; reject: (reason: unknown) => void }[]>();
  private running = false;
  private blockedUntil = 0;
  run<T>(guild: string, work: () => Promise<T>): Promise<T> {
    if ([...this.queues.values()].reduce((n, jobs) => n + jobs.length, 0) >= 1000) return Promise.reject(new SendError("Managed Discord outbound queue is full", false, 1000));
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
          if (error instanceof SendError && error.retryAfterMs) this.blockedUntil = Math.max(this.blockedUntil, Date.now() + error.retryAfterMs);
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
      intents: (1 << 0) | (1 << 9) | (1 << 12),
      dispatch: (event, data) => {
        // GUILD_MESSAGES delivers every message in every server: only mentions and DMs are queued, and the queue is bounded.
        if (event === "READY") this.botId = String(data?.user?.id ?? "");
        else if (event === "MESSAGE_CREATE" && data?.guild_id && !data.mentions?.some((user: any) => user?.id === this.botId)) return;
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
        if (!await this.destination(binding.id, conversation, true)) throw new SendError("Managed Discord destination is unavailable or not permitted", true);
        return work();
      });
    };
    this.provider = {
      label: "Camel Discord", managed: true, needsCredentials: false,
      maxMessageLength: this.transport.maxMessageLength, maxFileBytes: this.transport.maxFileBytes, typingMs: this.transport.typingMs,
      defaults: { access: { public: false }, limits: { perSenderPerMinute: 5, turnsPerDay: 100 } },
      setup: async given => {
        const binding = await this.byId(given.bindingId);
        if (!binding) throw new HttpError(403, "Create this channel through verified Discord server setup");
        return { account: { id: options.applicationId, guildId: binding.guild_id, username: "Camel" }, masked: {} };
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
      typing: (given, conversation) => delivery(given, conversation, () => this.transport.typing!(credentials, conversation)),
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
      // Delivery nodes share a fence and cooldown. A 429 commits its cooldown before the durable item retries.
      const result = await transaction(this.options.db, async sql => {
        await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`discord-rest:${this.options.applicationId}`]);
        const key = `${this.options.applicationId}:rest`;
        const row = (await sql.query("select until_at from discord_setup_cooldowns where key=$1", [key])).rows[0];
        if (row?.until_at > Date.now()) return { error: new SendError("Discord global delivery cooldown", false, row.until_at - Date.now()) };
        try { return { value: await work() }; }
        catch (error) {
          if (error instanceof SendError && error.retryAfterMs) await sql.query(`insert into discord_setup_cooldowns (key,until_at) values ($1,$2) on conflict (key) do update set until_at=greatest(discord_setup_cooldowns.until_at,excluded.until_at)`, [key, Date.now() + error.retryAfterMs]);
          return { error };
        }
      });
      if ("error" in result) throw result.error;
      return result.value;
    });
  }
  private async bot(path: string, scheduled = false) {
    const key = `${this.options.applicationId}:rest`;
    if (!scheduled) {
      const cooldown = (await this.options.db.query("select until_at from discord_setup_cooldowns where key=$1", [key])).rows[0];
      if (cooldown?.until_at > Date.now()) throw new SendError("Discord global delivery cooldown", false, cooldown.until_at - Date.now());
    }
    const response = await fetch(`${this.base}${path}`, { headers: { Authorization: `Bot ${this.options.botToken}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      if (response.status === 429) {
        const body = await response.json().catch(() => ({})) as any;
        const retryAfter = Math.max(1000, Number(body.retry_after ?? 1) * 1000);
        if (!scheduled) await this.options.db.query(`insert into discord_setup_cooldowns (key,until_at) values ($1,$2) on conflict (key) do update set until_at=greatest(discord_setup_cooldowns.until_at,excluded.until_at)`, [key, Date.now() + retryAfter]);
        throw new SendError("Discord is rate limiting managed requests", false, retryAfter);
      }
      throw new HttpError(response.status === 404 ? 404 : 502, response.status === 404 ? "Camel is not installed or cannot access this Discord destination" : `Discord request failed (HTTP ${response.status})`);
    }
    return response.json() as Promise<any>;
  }
  private async byId(id: string | undefined): Promise<Binding | undefined> {
    if (!id) return undefined;
    return (await this.options.db.query(`select b.*, i.state installation_state, i.name guild_name from discord_server_bindings b join discord_installations i using (application_id,guild_id) where b.id=$1 and b.application_id=$2`, [id, this.options.applicationId])).rows[0];
  }
  private async byGuild(guild: string): Promise<Binding | undefined> {
    return (await this.options.db.query(`select b.*, i.state installation_state, i.name guild_name from discord_server_bindings b join discord_installations i using (application_id,guild_id) where b.guild_id=$1 and b.application_id=$2`, [guild, this.options.applicationId])).rows[0];
  }
  private async byChannel(channel: string): Promise<Binding | undefined> {
    return (await this.options.db.query(`select b.*, i.state installation_state, i.name guild_name from discord_server_bindings b join discord_installations i using (application_id,guild_id) where b.channel_id=$1 and b.application_id=$2`, [channel, this.options.applicationId])).rows[0];
  }
  private async destination(bindingId: string, channelId: string, scheduled = false) {
    if (!ID.test(channelId)) return false;
    let binding = await this.byId(bindingId);
    if (!binding || binding.state !== "active" || !binding.channel_id || binding.installation_state !== "present") return false;
    // An allowed channel was checked against this guild when it was saved, and a channel never changes guild: only threads need a lookup.
    if (binding.allowed_channel_ids.includes(channelId)) return true;
    let channel;
    try { channel = await this.bot(`/channels/${channelId}`, scheduled); }
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
    await this.options.db.query("delete from discord_account_links where expires_at<=$1", [now]);
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
        await sql.query(`update discord_server_bindings b set state='paused',updated_at=$2 from discord_installations i where b.application_id=i.application_id and b.guild_id=i.guild_id and i.application_id=$1 and i.state='removed' and b.state='active'`, [this.options.applicationId, Date.now()]);
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
    if (!data.guild_id) {
      await this.status(data.channel_id, "dm", `Configure Camel for a Discord server in the console: ${new URL("/console/channels", this.options.publicUrl).href}`);
      return;
    }
    if (!ID.test(data.guild_id) || !data.mentions?.some((user: any) => user?.id === this.botId)) return;
    const binding = await this.byGuild(data.guild_id);
    if (!binding) {
      await this.status(data.channel_id, data.guild_id, `I'm not set up for this server yet. A server admin can configure me here: ${this.setupUrl(data.guild_id)}`);
      return;
    }
    if (binding.state === "disconnected") return;
    if (binding.state !== "active" || binding.installation_state !== "present") {
      await this.status(data.channel_id, data.guild_id, `Camel is paused or unavailable for this server. A server admin can manage it here: ${this.setupUrl(data.guild_id)}`);
      return;
    }
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
      if (state === "removed" || prior?.state === "removed") {
        await sql.query(`update discord_server_bindings set state='paused',updated_at=$3 where application_id=$1 and guild_id=$2 and state='active'`, [this.options.applicationId, guild, Date.now()]);
        await sql.query(`delete from channel_items where item->>'channel' in (select channel_id from discord_server_bindings where application_id=$1 and guild_id=$2)`, [this.options.applicationId, guild]);
      }
    });
  }
  private setupUrl(guild: string) { const url = new URL("/console/channels", this.options.publicUrl); url.searchParams.set("discord_setup", guild); return url.href; }
  private async status(channel: string, guild: string, content: string) {
    if (!this.current()) return;
    const allowed = await underClaim(this.options.db, this.claim, async sql => {
      const now = Date.now();
      const local = await sql.query(`insert into discord_setup_cooldowns (key,until_at) values ($1,$2) on conflict (key) do update set until_at=excluded.until_at,count=1 where discord_setup_cooldowns.until_at<=$3 returning key`, [`${this.options.applicationId}:${guild}:${channel}`, now + 60_000, now]);
      if (!local.rowCount) return false;
      const global = await sql.query(`insert into discord_setup_cooldowns (key,until_at) values ($1,$2) on conflict (key) do update set count=case when discord_setup_cooldowns.until_at<=$3 then 1 else discord_setup_cooldowns.count+1 end,until_at=case when discord_setup_cooldowns.until_at<=$3 then excluded.until_at else discord_setup_cooldowns.until_at end returning count`, [`${this.options.applicationId}:global`, now + 60_000, now]);
      await sql.query("delete from discord_setup_cooldowns where until_at<$1", [now - 60_000]);
      return global.rows[0].count <= 100;
    });
    if (allowed) void this.scheduled(guild, async () => {
      if (!this.current()) return;
      const destination = await this.bot(`/channels/${channel}`, true);
      if (!this.current() || (guild === "dm" ? !!destination.guild_id : destination.guild_id !== guild)) return;
      await this.transport.send({ botToken: this.options.botToken }, channel, content);
    }).catch(() => this.log("status_failed"));
  }

  private session(req: Request) { return hash((req.headers.get("cookie") ?? "").split(";").map(value => value.trim()).find(value => value.startsWith("ar_session=")) ?? ""); }
  private encrypt(value: string, context: string) {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", Buffer.from(hash(this.options.consoleAuth.options.secret), "hex"), iv);
    cipher.setAAD(Buffer.from(context));
    return [iv.toString("base64url"), Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  }
  private decrypt(value: string, context: string) {
    const [iv, ciphertext, tag] = value.split("."); const decipher = createDecipheriv("aes-256-gcm", Buffer.from(hash(this.options.consoleAuth.options.secret), "hex"), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }
  private async linked(req: Request, tenant: string) {
    const session = this.session(req);
    const link = (await this.options.db.query("select * from discord_account_links where tenant=$1 and session_hash=$2 and expires_at>$3", [tenant, session, Date.now()])).rows[0];
    if (!link) throw new HttpError(403, "Connect your Discord account again to verify server management permissions");
    return { userId: String(link.discord_user_id), token: this.decrypt(link.token, `${tenant}:${session}`) };
  }
  private async guilds(token: string) {
    const result: any[] = []; let after = "";
    for (;;) {
      const response = await fetch(`${this.base}/users/@me/guilds?limit=200${after ? `&after=${after}` : ""}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new HttpError(403, "Discord account authorization expired; connect your Discord account again");
      const page = await response.json() as any[];
      if (!Array.isArray(page)) throw new HttpError(502, "Discord returned an invalid server list");
      result.push(...page);
      if (page.length < 200) return result;
      const next = String(page.at(-1)?.id ?? "");
      if (!ID.test(next) || next === after || result.length > 10_000) throw new HttpError(502, "Discord returned invalid server pagination");
      after = next;
    }
  }
  private async permission(req: Request, tenant: string, guildId: string) {
    if (!ID.test(guildId)) throw new HttpError(400, "Expected a Discord server ID");
    const link = await this.linked(req, tenant);
    const guild = (await this.guilds(link.token)).find(guild => guild.id === guildId);
    if (!guild || !managesGuild(guild)) throw new HttpError(403, "You must own this Discord server or have Manage Server or Administrator permission");
    return { guild, userId: link.userId };
  }
  /** Hook for all generic definition mutation paths, including API-key requests and apply. */
  async authorizeDefinition(req: Request, tenant: string, definition: string) {
    const rows = (await this.options.db.query(`select b.guild_id from discord_server_bindings b join channels c on c.id=b.channel_id where b.tenant=$1 and b.application_id=$2 and (c.channel->>'definition'=$3 or exists (select 1 from channel_agents ca join agents a on a.id=ca.agent where ca.channel=b.channel_id and a.tenant=b.tenant and a.header->'definition'->>'id'=$3))`, [tenant, this.options.applicationId, definition])).rows;
    for (const row of rows) await this.permission(req, tenant, row.guild_id);
  }
  private async verifiedInstallation(guildId: string) {
    const guild = await this.bot(`/guilds/${guildId}`);
    if (guild.id !== guildId) throw new HttpError(403, "Camel is not installed in this server");
    // Console writes are not Gateway-owned; a later Gateway removal still fences all delivery.
    await this.options.db.query(`insert into discord_installations (application_id,guild_id,name,state,updated_at) values ($1,$2,$3,'present',$4) on conflict (application_id,guild_id) do update set name=excluded.name,state='present',updated_at=excluded.updated_at`, [this.options.applicationId, guildId, guild.name ?? "", Date.now()]);
    return guild;
  }
  private async validateChannels(guildId: string, ids: string[]) {
    for (const id of ids) {
      const channel = await this.bot(`/channels/${id}`);
      if (channel.guild_id !== guildId || ![0, 5, 10, 11, 12, 15, 16].includes(channel.type)) throw new HttpError(400, "Allowed channels must be message channels or threads in this Discord server");
    }
  }
  private withBindingLock<T>(guild: string, work: () => Promise<T>): Promise<T> {
    // Reserve at most one mutation connection per node: Channels uses the same pool for its own durable writes.
    const result = this.mutationTail.then(() => transaction(this.options.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`discord-binding:${this.options.applicationId}:${guild}`]);
      return work();
    }));
    this.mutationTail = result.then(() => {}, () => {});
    return result;
  }
  private async view(binding: Binding) {
    return {
      guildId: binding.guild_id, guildName: binding.guild_name ?? "", state: binding.state,
      installationState: binding.installation_state, channelId: binding.channel_id, allowedChannelIds: binding.allowed_channel_ids,
      ...(binding.channel_id ? { channel: await this.channels().get(binding.tenant, binding.channel_id) } : {}),
    };
  }
  async authorizeAgent(req: Request, tenant: string, agent: string) {
    const rows = (await this.options.db.query(`select b.guild_id from discord_server_bindings b join channel_agents a on a.channel=b.channel_id where b.tenant=$1 and b.application_id=$2 and a.agent=$3`, [tenant, this.options.applicationId, agent])).rows;
    for (const row of rows) await this.permission(req, tenant, row.guild_id);
  }
  private routes() {
    const app = new Hono();
    app.use("/console/discord/*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      const principal = await this.options.consoleAuth.principal(c.req.raw);
      if (!principal) return c.json({ error: "Sign in to the Camel console" }, 401);
      if (c.req.method !== "GET" && !this.options.consoleAuth.allowsMutation(c.req.raw)) return c.json({ error: "Use a same-origin console request" }, 403);
      c.set("tenant" as never, principal.tenant as never);
      await next();
    });
    const tenant = (c: any): string => c.get("tenant");
    app.get("/console/discord/config", c => {
      const invite = new URL("https://discord.com/oauth2/authorize");
      invite.searchParams.set("client_id", this.options.applicationId);
      invite.searchParams.set("scope", "bot applications.commands");
      invite.searchParams.set("permissions", "274878008320");
      invite.searchParams.set("integration_type", "0");
      return c.json({ enabled: true, applicationId: this.options.applicationId, inviteUrl: invite.href, setupPath: "/console/channels" });
    });
    app.post("/console/discord/authorize", async c => {
      const body = z.object({ guildId: snowflake.optional() }).strict().parse(await readJson(c.req.raw.body, 4096, {}));
      const state = randomBytes(32).toString("base64url"); const now = Date.now();
      await this.options.db.query("delete from discord_setup_attempts where expires_at<$1", [now]);
      await this.options.db.query("delete from discord_account_links where expires_at<$1", [now]);
      await this.options.db.query("insert into discord_setup_attempts (state_hash,tenant,session_hash,guild_id,expires_at) values ($1,$2,$3,$4,$5)", [hash(state), tenant(c), this.session(c.req.raw), body.guildId ?? null, now + 10 * 60_000]);
      const url = new URL("https://discord.com/oauth2/authorize");
      url.searchParams.set("client_id", this.options.applicationId); url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "identify guilds"); url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", new URL("/console/discord/callback", this.options.publicUrl).href);
      return c.json({ url: url.href });
    });
    app.get("/console/discord/callback", async c => {
      const state = c.req.query("state") ?? "";
      const setup = new URL("/console/channels", this.options.publicUrl);
      try {
        const attempt = (await this.options.db.query("delete from discord_setup_attempts where state_hash=$1 and tenant=$2 and session_hash=$3 and expires_at>$4 returning *", [hash(state), tenant(c), this.session(c.req.raw), Date.now()])).rows[0];
        if (!attempt || !state) throw new HttpError(400, "Discord setup state expired or does not match this console session");
        if (attempt.guild_id) setup.searchParams.set("discord_setup", attempt.guild_id);
        if (c.req.query("error")) throw new HttpError(400, "Discord authorization was cancelled");
        const code = c.req.query("code"); if (!code) throw new HttpError(400, "Discord authorization did not return a code");
        const response = await fetch(`${this.base}/oauth2/token`, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: this.options.applicationId, client_secret: this.options.clientSecret, grant_type: "authorization_code", code, redirect_uri: new URL("/console/discord/callback", this.options.publicUrl).href }), signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new HttpError(403, "Discord could not verify the authorization code");
        const grant = await response.json() as any;
        if (typeof grant.access_token !== "string" || !String(grant.scope ?? "").split(" ").includes("guilds") || !String(grant.scope ?? "").split(" ").includes("identify")) throw new HttpError(403, "Discord authorization is missing account and server permissions");
        const meResponse = await fetch(`${this.base}/users/@me`, { headers: { Authorization: `Bearer ${grant.access_token}` }, signal: AbortSignal.timeout(15_000) });
        if (!meResponse.ok) throw new HttpError(403, "Discord could not verify your identity");
        const me = await meResponse.json() as any;
        if (!ID.test(me.id)) throw new HttpError(403, "Discord returned an invalid identity");
        const session = this.session(c.req.raw); const account = tenant(c);
        await this.options.db.query(`insert into discord_account_links (tenant,session_hash,discord_user_id,token,expires_at) values ($1,$2,$3,$4,$5) on conflict (tenant,session_hash) do update set discord_user_id=excluded.discord_user_id,token=excluded.token,expires_at=excluded.expires_at`, [account, session, me.id, this.encrypt(grant.access_token, `${account}:${session}`), Date.now() + Math.min(LINK_MS, Math.max(0, Number(grant.expires_in ?? 900)) * 1000)]);
        setup.searchParams.set("discord_connected", "1");
      } catch (error) { setup.searchParams.set("discord_error", error instanceof HttpError ? error.message : "Discord account linking failed; try again"); }
      return c.redirect(setup.href);
    });
    app.get("/console/discord/guilds", async c => {
      let link;
      try { link = await this.linked(c.req.raw, tenant(c)); }
      catch (error) { if (error instanceof HttpError && error.status === 403) return c.json({ linked: false, guilds: [] }); throw error; }
      const guilds = (await this.guilds(link.token)).filter(managesGuild);
      const installations = (await this.options.db.query(`select i.*,b.tenant,b.state binding_state from discord_installations i left join discord_server_bindings b using(application_id,guild_id) where i.application_id=$1`, [this.options.applicationId])).rows;
      return c.json({ linked: true, guilds: guilds.map(guild => {
        const installation = installations.find(row => row.guild_id === guild.id);
        return { id: guild.id, name: guild.name, installed: installation?.state === "present", installationState: installation?.state ?? null, bindingState: installation?.binding_state ?? null, owned: installation?.tenant === tenant(c), conflict: !!installation?.tenant && installation.tenant !== tenant(c) };
      }) });
    });
    app.get("/console/discord/bindings", async c => {
      const bindings = (await this.options.db.query(`select b.*,i.state installation_state,i.name guild_name from discord_server_bindings b join discord_installations i using(application_id,guild_id) where b.application_id=$1 and b.tenant=$2 order by b.created_at`, [this.options.applicationId, tenant(c)])).rows as Binding[];
      return c.json({ bindings: await Promise.all(bindings.map(binding => this.view(binding))) });
    });
    app.get("/console/discord/guilds/:guildId/channels", async c => {
      const guildId = c.req.param("guildId");
      await this.permission(c.req.raw, tenant(c), guildId); await this.verifiedInstallation(guildId);
      const channels = await this.bot(`/guilds/${guildId}/channels`);
      return c.json({ channels: channels.filter((channel: any) => [0, 5, 15, 16].includes(channel.type)).map((channel: any) => ({ id: channel.id, name: channel.name, type: channel.type })) });
    });
    app.post("/console/discord/bindings", async c => {
      const parsed = createSchema.safeParse(await readJson(c.req.raw.body, 16_384));
      if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
      const input = parsed.data; const account = tenant(c);
      return this.withBindingLock(input.guildId, async () => {
        const permission = await this.permission(c.req.raw, account, input.guildId);
        await this.verifiedInstallation(input.guildId); await this.validateChannels(input.guildId, input.allowedChannelIds);
        const now = Date.now(); const bindingId = randomUUID();
        let binding = await this.byGuild(input.guildId);
        if (binding) {
          if (binding.tenant !== account) throw new HttpError(409, "This Discord server is already connected to another Camel account");
          if (binding.channel_id) throw new HttpError(409, "This server already has a binding; update or reconnect it");
          // A process may have stopped between reservation and channel persistence. Reuse its binding ID safely.
          await this.options.db.query("update discord_server_bindings set allowed_channel_ids=$2,administrator_id=$3,updated_at=$4 where id=$1", [binding.id, JSON.stringify(input.allowedChannelIds), permission.userId, now]);
        } else {
          binding = (await this.options.db.query(`insert into discord_server_bindings (id,application_id,guild_id,tenant,state,allowed_channel_ids,administrator_id,created_at,updated_at) values ($1,$2,$3,$4,'paused',$5,$6,$7,$7) returning *`, [bindingId, this.options.applicationId, input.guildId, account, JSON.stringify(input.allowedChannelIds), permission.userId, now])).rows[0] as Binding;
        }
        let channelId: string | undefined;
        try {
          const orphan = (await this.options.db.query(`select id from channels where tenant=$1 and channel->>'type'='discord-managed' and channel->'account'->>'guildId'=$2`, [account, input.guildId])).rows[0];
          const channel = orphan ? await this.channels().update(account, orphan.id, { definition: input.definition, name: input.name, access: input.access, limits: input.limits }, { managed: true }) : await this.channels().create(account, { type: "discord-managed", definition: input.definition, name: input.name ?? `Camel · ${permission.guild.name}`, access: input.access, limits: input.limits, credentials: { bindingId: binding.id } }, { managed: true });
          channelId = channel.id;
          await this.options.db.query("update discord_server_bindings set channel_id=$2,state=case when $3::text='active' and not exists (select 1 from discord_installations i where i.application_id=discord_server_bindings.application_id and i.guild_id=discord_server_bindings.guild_id and i.state='present') then 'paused' else $3 end,updated_at=$4 where id=$1", [binding.id, channel.id, input.state ?? "active", Date.now()]);
        } catch (error) {
          if (channelId) await this.channels().remove(account, channelId, { managed: true }).catch(() => {});
          await this.options.db.query("delete from discord_server_bindings where id=$1 and channel_id is null", [binding.id]);
          throw error;
        }
        this.log("binding_created", { guildId: input.guildId, tenant: account });
        return c.json(await this.view((await this.byId(binding!.id))!), 201);
      });
    });
    app.patch("/console/discord/bindings/:guildId", async c => {
      const parsed = inputSchema.safeParse(await readJson(c.req.raw.body, 16_384));
      if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
      const input = parsed.data; const guildId = c.req.param("guildId"); const account = tenant(c);
      return this.withBindingLock(guildId, async () => {
        const binding = await this.byGuild(guildId);
        if (!binding || binding.tenant !== account) throw new HttpError(404, "Discord server binding not found");
        // The paying account may always stop a server, even after losing its Discord role; anything else needs a current administrator.
        if (Object.keys(input).length === 1 && (input.state === "paused" || input.state === "disconnected")) {
          await this.options.db.query("update discord_server_bindings set state=$2,updated_at=$3 where id=$1", [binding.id, input.state, Date.now()]);
          if (binding.channel_id) await this.options.db.query("delete from channel_items where item->>'channel'=$1", [binding.channel_id]);
          this.log("binding_updated", { guildId, tenant: account, state: input.state });
          return c.json(await this.view((await this.byId(binding.id))!));
        }
        const permission = await this.permission(c.req.raw, account, guildId);
        if (!binding.channel_id) throw new HttpError(409, "This server setup has not completed; contact the runtime operator");
        // Disconnect and pause remain possible after the bot is physically removed.
        if (input.state !== "paused" && input.state !== "disconnected") await this.verifiedInstallation(guildId);
        if (input.allowedChannelIds) await this.validateChannels(guildId, input.allowedChannelIds);
        const update: ChannelInput = { ...(input.definition ? { definition: input.definition } : {}), ...(input.name ? { name: input.name } : {}), ...(input.access ? { access: input.access } : {}), ...(input.limits ? { limits: input.limits } : {}) };
        // Fence queued work before updating policy, so no turn observes a mixture of old and new grants.
        await this.options.db.query("update discord_server_bindings set state='paused',updated_at=$2 where id=$1", [binding.id, Date.now()]);
        await this.options.db.query("delete from channel_items where item->>'channel'=$1", [binding.channel_id]);
        await this.channels().update(account, binding.channel_id, update, { managed: true });
        const applied = input.definition && this.options.applyDefinition ? await this.options.applyDefinition(account, binding.channel_id, input.definition) : undefined;
        await this.options.db.query(`update discord_server_bindings set state=case when $2::text='active' and not exists (select 1 from discord_installations i where i.application_id=discord_server_bindings.application_id and i.guild_id=discord_server_bindings.guild_id and i.state='present') then 'paused' else $2 end,allowed_channel_ids=$3,administrator_id=$4,updated_at=$5 where id=$1`, [binding.id, input.state ?? binding.state, JSON.stringify(input.allowedChannelIds ?? binding.allowed_channel_ids), permission.userId, Date.now()]);
        this.log("binding_updated", { guildId, tenant: account, state: input.state ?? binding.state });
        return c.json({ ...await this.view((await this.byId(binding.id))!), ...(applied ? { applied } : {}) });
      });
    });
    app.post("/channels/discord-managed/interactions", async c => {
      const body = await readText(c.req.raw.body, 64 * 1024);
      if (!verifyInteraction(this.options.publicKey, c.req.raw.headers, body)) return c.body(null, 401);
      let interaction: any; try { interaction = JSON.parse(body); } catch { return c.body(null, 400); }
      if (interaction.type === 1) return c.json({ type: 1 });
      if (interaction.application_id !== this.options.applicationId || interaction.type !== 2 || interaction.data?.name !== "camel" || interaction.data?.options?.[0]?.name !== "setup") return c.body(null, 400);
      let content = `Open the Camel console to configure a Discord server: ${new URL("/console/channels", this.options.publicUrl).href}`;
      if (ID.test(interaction.guild_id ?? "")) {
        content = managesGuild({ permissions: interaction.member?.permissions })
          ? `Set up or manage Camel for this server: ${this.setupUrl(interaction.guild_id)}`
          : "A server owner or member with Manage Server permission can configure Camel in the console.";
      }
      return c.json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
    });
    app.onError((error, c) => {
      const status = error instanceof HttpError ? error.status : error instanceof SendError ? 503 : error instanceof z.ZodError ? 400 : 500;
      return c.json({ error: status < 500 ? error.message : "Managed Discord request failed; try again" }, status as 400 | 403 | 404 | 409 | 500);
    });
    return app;
  }
}
