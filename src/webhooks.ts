import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Accounts, Sealed } from "./accounts.ts";
import type { UsageRecord } from "./client-sessions.ts";
import type { Db, Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Outbound } from "./outbound.ts";
import { errorText } from "./protocol.ts";
import { deliveryLine, recordEventMetrics, writeMetricLine } from "./metrics.ts";

/**
 * Webhooks: a tenant registers endpoints, each a URL and the event types it receives, and each
 * event is POSTed to every endpoint that selected its type, in an envelope `{id, type, created,
 * data}` signed per Standard Webhooks. Events are written to a Postgres outbox where they become
 * durable: usage in the transaction of the usage flush that counts it, an input's events in the
 * transaction that changes its row, a run's once its record is. Any node sends them, each claimed
 * by one node at a time, retrying with backoff until acknowledged, so delivery is at least once:
 * receivers dedupe by `id`, which an event keeps when it is written again.
 *
 * The usage webhook (`/v1/usage-webhook`), from before endpoints, keeps its own table, outbox and flat
 * body, as before: nodes of an earlier release, which send from that outbox during a deploy, never see
 * an endpoint's deliveries, and a change they make to the usage webhook is the one every node reads.
 */
export const EVENT_TYPES = ["run.started", "run.completed", "run.failed", "input.requested", "input.resolved", "usage.recorded", "billing.balance.low", "billing.balance.depleted", "billing.topup.receipt", "billing.topup.declined", "billing.topup.action_required", "billing.topup.no_card", "billing.topup.limit", "billing.topup.reconcile"] as const;
export type EventType = typeof EVENT_TYPES[number];
/** An event for the tenant's endpoints; `legacy` is a usage event's body for the usage webhook. */
export type WebhookEvent = { id: string; type: EventType; tenant: string; created: number; data: Record<string, unknown>; legacy?: UsageEvent };
/** A usage event as the usage webhook sends it. */
export type UsageEvent = {
  id: string; agent: string; requestId: string | null; tenant: string; subject: string; actor: string | null; context: Record<string, unknown>;
  keyScope: string | null; provider: string; model: string; kind: "response" | "compaction";
  input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number;
  cost: { usd: number; source: "provider" | "catalog" }; at: number;
};
type Receiver = { url: string; secrets: string[] };
export type Endpoint = { id: string; url: string; events: EventType[]; description?: string; createdAt: number };

const MAX_ENDPOINTS = 16;
const CLAIM_BATCH = 100;
/** A claimed delivery is left to others if its node has not settled it by then. */
const LEASE_MS = 60_000;
const TIMEOUT_MS = 10_000;
/** Undelivered events are dropped after this long. */
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;
/** A replaced secret keeps signing, beside the new one, for this long. */
const ROTATION_MS = 24 * 60 * 60_000;
const newSecret = () => `whsec_${randomBytes(24).toString("base64")}`;
/** What a secret is sealed to: an endpoint's, or the tenant's usage webhook's (`id` undefined). */
const aad = (tenant: string, id?: string) => id === undefined ? `usage-webhook:${tenant}` : `webhook:${tenant}:${id}`;

/** An event's id: from `key` (its type and what it is about), the same each time it is written; random without one. */
export function eventId(key?: string) {
  return `evt_${key === undefined ? randomBytes(12).toString("hex") : createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

/** An event, now. */
export function webhookEvent(type: EventType, tenant: string, data: Record<string, unknown>, key?: string): WebhookEvent {
  return { id: eventId(key), type, tenant, created: Math.floor(Date.now() / 1000), data };
}

/**
 * Add events to the outboxes: one delivery per endpoint that selected their type (none for a tenant
 * without one; one already there is left as it is), and usage to the tenant's usage webhook, if set.
 */
export async function enqueueEvents(sql: Sql, events: WebhookEvent[]) {
  if (!events.length) return;
  await sql.query(`
    insert into webhook_deliveries (id, tenant, endpoint, body, due, created_at)
    select md5((e->>'id') || ':' || w.id)::uuid, w.tenant, w.id, jsonb_build_object('id', e->'id', 'type', e->'type', 'created', e->'created', 'data', e->'data'), $2, $2
    from jsonb_array_elements($1::jsonb) as e join webhook_endpoints w on w.tenant = e->>'tenant' and e->>'type' = any(w.events)
    on conflict (id) do nothing`, [JSON.stringify(events), Date.now()]);
  const legacy = events.flatMap(event => event.legacy ? [event.legacy] : []);
  if (legacy.length) await sql.query(`
    insert into usage_webhook_outbox (id, tenant, body, due, created_at)
    select (e->>'id')::uuid, e->>'tenant', e, $2, $2 from jsonb_array_elements($1::jsonb) as e
    where exists (select 1 from usage_webhooks w where w.tenant = e->>'tenant')`, [JSON.stringify(legacy), Date.now()]);
  recordEventMetrics(events);
}

/** A model response's cost: the provider's own report when it made one (OpenRouter's), else the catalog price. */
export function usageCost(usage: any): { usd: number; source: "provider" | "catalog" } {
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (valid(usage?.providerCost)) return { usd: usage.providerCost, source: "provider" };
  return { usd: valid(usage?.cost?.total) ? usage.cost.total : 0, source: "catalog" };
}

/** The `usage.recorded` event for a model response, or undefined for other usage (web searches, renders, tool search). */
export function usageEvent(tenant: string, agent: string, message: UsageRecord): WebhookEvent | undefined {
  if (message.searches || message.renders || message.toolSearch) return undefined;
  const usage = message.usage ?? {};
  // A tenant endpoint's calls are named as its agents name the model: `chiridion` / `openai-codex/gpt-5.5`.
  const [provider, ...upstream] = (message.provider ?? "unknown").split("/");
  const facts = {
    requestId: message.requestId ?? null, subject: message.identity?.subject ?? agent, actor: message.actor ?? null,
    context: message.identity?.context ?? {}, keyScope: message.keyScope ?? null, provider, model: [...upstream, message.model ?? "unknown"].join("/"),
    kind: message.kind === "compaction" ? "compaction" as const : "response" as const,
    input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0,
    ...(typeof usage.reasoning === "number" ? { reasoning: usage.reasoning } : {}), cost: usageCost(usage),
  };
  const at = message.timestamp ?? Date.now();
  return { ...webhookEvent("usage.recorded", tenant, { agentId: agent, ...facts, at }), legacy: { id: randomUUID(), agent, tenant, ...facts, at } };
}

/** Standard Webhooks headers for `body`, signed with each secret (`whsec_<base64 key>`). */
export function signedHeaders(id: string, body: string, secrets: string[], now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  const signatures = secrets.map(secret => `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`);
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signatures.join(" ") };
}

/** An endpoint's event selection: known types, at least one, each once. */
function eventsInput(value: unknown): EventType[] {
  if (!Array.isArray(value) || !value.length || value.some(type => !EVENT_TYPES.includes(type)) || new Set(value).size !== value.length) {
    throw new HttpError(400, `events must list some of ${EVENT_TYPES.join(", ")}, each once`);
  }
  return value;
}

function descriptionInput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 500) throw new HttpError(400, "description must be a string of at most 500 characters");
  return value;
}

/** Where nodes hear that a tenant's endpoints changed (payload: the tenant), so their `Subscribers` read them again. */
export const ENDPOINTS_CHANNEL = "agent_runtime_webhooks";

/**
 * Which tenants have an endpoint for run events, as this node last read it, so a run of a tenant with none writes
 * no event (and journals no mark that it did). A change on any node is heard at once (`ENDPOINTS_CHANNEL`); the
 * TTL only covers notifications the listening connection missed. A failed read counts as yes.
 */
export class Subscribers {
  private readonly db: Db;
  private readonly ttlMs: number;
  private readonly tenants = new Map<string, { runs: Promise<boolean>; until: number }>();
  constructor(db: Db, ttlMs = 60_000) { this.db = db; this.ttlMs = ttlMs; }

  runs(tenant: string): Promise<boolean> {
    const cached = this.tenants.get(tenant);
    if (cached && cached.until > Date.now()) return cached.runs;
    if (this.tenants.size >= 10_000) for (const [key, entry] of this.tenants) if (entry.until <= Date.now()) this.tenants.delete(key);
    const runs = this.db.query("select exists (select 1 from webhook_endpoints where tenant = $1 and events && $2::text[]) as runs", [tenant, RUN_EVENTS])
      .then(({ rows }) => rows[0].runs as boolean, () => { this.tenants.delete(tenant); return true; });
    this.tenants.set(tenant, { runs, until: Date.now() + this.ttlMs });
    return runs;
  }

  forget(tenant: string) { this.tenants.delete(tenant); }
}
const RUN_EVENTS = EVENT_TYPES.filter(type => type.startsWith("run."));

const endpointView = (row: any): Endpoint => ({ id: row.id, url: row.url, events: row.events, ...(row.description ? { description: row.description } : {}), createdAt: Number(row.created_at) });

export class Webhooks {
  private readonly db: Db;
  private readonly accounts: Accounts;
  private readonly outbound: Outbound;
  private readonly retryBaseMs: number;
  private readonly subscribers?: Subscribers;
  private timer?: ReturnType<typeof setInterval>;
  private sending = false;

  constructor(options: { db: Db; accounts: Accounts; outbound: Outbound; retryBaseMs?: number; subscribers?: Subscribers }) {
    this.db = options.db;
    this.accounts = options.accounts;
    this.outbound = options.outbound;
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    this.subscribers = options.subscribers;
  }

  /** Tell every node the tenant's endpoints changed; this one forgets at once. */
  private async changed(tenant: string) {
    this.subscribers?.forget(tenant);
    await this.db.query("select pg_notify($1, $2)", [ENDPOINTS_CHANNEL, tenant]).catch(() => {});
  }

  private checkUrl(url: unknown): string {
    if (typeof url !== "string") throw new HttpError(400, "url must be a string");
    try { this.outbound.check(url); } catch (error) { throw new HttpError(400, errorText(error)); }
    return url;
  }

  async list(tenant: string): Promise<Endpoint[]> {
    return (await this.db.query("select * from webhook_endpoints where tenant = $1 order by created_at, id", [tenant])).rows.map(endpointView);
  }

  async get(tenant: string, id: string): Promise<Endpoint> {
    const row = (await this.db.query("select * from webhook_endpoints where tenant = $1 and id = $2", [tenant, id])).rows[0];
    if (!row) throw new HttpError(404, "Unknown webhook endpoint");
    return endpointView(row);
  }

  /** Register an endpoint; its signing secret is returned only now. */
  async create(tenant: string, input: { url?: unknown; events?: unknown; description?: unknown }) {
    const url = this.checkUrl(input.url);
    const events = eventsInput(input.events);
    const id = `we_${randomBytes(12).toString("hex")}`;
    const secret = newSecret();
    const { rows } = await this.db.query(`
      insert into webhook_endpoints (id, tenant, url, events, description, secret, created_at)
      select $1, $2, $3, $4, $5, $6, $7 where (select count(*) from webhook_endpoints where tenant = $2) < ${MAX_ENDPOINTS}
      returning *`, [id, tenant, url, events, descriptionInput(input.description), this.accounts.seal(aad(tenant, id), secret), Date.now()]);
    if (!rows[0]) throw new HttpError(409, `A tenant has at most ${MAX_ENDPOINTS} webhook endpoints`);
    await this.changed(tenant);
    return { ...endpointView(rows[0]), secret };
  }

  /** Change an endpoint's URL, events or description; what is left out stays. */
  async update(tenant: string, id: string, input: { url?: unknown; events?: unknown; description?: unknown }) {
    const url = input.url === undefined ? null : this.checkUrl(input.url);
    const events = input.events === undefined ? null : eventsInput(input.events);
    const row = (await this.db.query(`
      update webhook_endpoints set url = coalesce($3, url), events = coalesce($4, events), description = case when $5 then $6 else description end
      where tenant = $1 and id = $2 returning *`, [tenant, id, url, events, input.description !== undefined, descriptionInput(input.description)])).rows[0];
    if (!row) throw new HttpError(404, "Unknown webhook endpoint");
    await this.changed(tenant);
    return endpointView(row);
  }

  /** Remove an endpoint, and the deliveries still waiting for it. */
  async delete(tenant: string, id: string) {
    const { rowCount } = await this.db.query("delete from webhook_endpoints where tenant = $1 and id = $2", [tenant, id]);
    if (!rowCount) throw new HttpError(404, "Unknown webhook endpoint");
    await this.db.query("delete from webhook_deliveries where endpoint = $1", [id]);
    await this.changed(tenant);
  }

  /** A new signing secret, returned only now; the old one also signs for a day, so receivers can switch. */
  async rotate(tenant: string, id: string) {
    const secret = newSecret();
    const { rowCount } = await this.db.query("update webhook_endpoints set previous = secret, previous_until = $4, secret = $3 where tenant = $1 and id = $2",
      [tenant, id, this.accounts.seal(aad(tenant, id), secret), Date.now() + ROTATION_MS]);
    if (!rowCount) throw new HttpError(404, "Unknown webhook endpoint");
    return { secret };
  }

  // The usage webhook, as before endpoints: in usage_webhooks, which nodes of every release read.

  async usageWebhook(tenant: string) {
    const row = (await this.db.query("select url, created_at from usage_webhooks where tenant = $1", [tenant])).rows[0];
    return row && { url: row.url as string, createdAt: Number(row.created_at) };
  }

  /** Set the usage webhook's URL. A tenant's first one gets a signing secret, returned only now. */
  async setUsageWebhook(tenant: string, url: unknown) {
    this.checkUrl(url);
    const secret = newSecret();
    const { rows } = await this.db.query(`
      insert into usage_webhooks (tenant, url, secret, created_at) values ($1, $2, $3, $4)
      on conflict (tenant) do update set url = excluded.url returning (xmax = 0) as created`, [tenant, url, this.accounts.seal(aad(tenant), secret), Date.now()]);
    return { url: url as string, ...(rows[0].created ? { secret } : {}) };
  }

  async rotateUsageWebhook(tenant: string) {
    const secret = newSecret();
    const { rowCount } = await this.db.query("update usage_webhooks set previous = secret, previous_until = $3, secret = $2 where tenant = $1",
      [tenant, this.accounts.seal(aad(tenant), secret), Date.now() + ROTATION_MS]);
    if (!rowCount) throw new HttpError(404, "No usage webhook is set");
    return { secret };
  }

  /** Remove the usage webhook, and the deliveries still waiting for it. */
  async deleteUsageWebhook(tenant: string) {
    const { rowCount } = await this.db.query("delete from usage_webhooks where tenant = $1", [tenant]);
    await this.db.query("delete from usage_webhook_outbox where tenant = $1", [tenant]);
    return !!rowCount;
  }

  start(intervalMs = 5_000) {
    this.timer ??= setInterval(() => void this.send().catch(error => console.error(JSON.stringify({ type: "webhook_scan_failed", error: errorText(error) }))), intervalMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** Send every due delivery, the usage webhook's and the endpoints', claiming batches so no two nodes send one at once. */
  async send(now = Date.now()) {
    if (this.sending) return;
    this.sending = true;
    try {
      await this.sendFrom("usage_webhook_outbox", now, row => this.usageReceiver(row.tenant));
      await this.sendFrom("webhook_deliveries", now, row => this.endpointReceiver(row.tenant, row.endpoint));
    } finally { this.sending = false; }
  }

  private async sendFrom(table: "usage_webhook_outbox" | "webhook_deliveries", now: number, receiver: (row: any) => Promise<Receiver | undefined>) {
    await this.db.query(`delete from ${table} where created_at < $1`, [now - MAX_AGE_MS]);
    for (;;) {
      const { rows } = await this.db.query(`
        update ${table} set due = $2, attempts = attempts + 1
        where id in (select id from ${table} where due <= $1 order by due limit ${CLAIM_BATCH} for update skip locked)
        returning *`, [Date.now(), Date.now() + LEASE_MS]);
      const receivers = new Map<string, Promise<Receiver | undefined>>();
      await Promise.all(rows.map(async row => {
        const key = row.endpoint ?? row.tenant;
        if (!receivers.has(key)) receivers.set(key, receiver(row));
        await this.deliver(table, row, await receivers.get(key));
      }));
      if (rows.length < CLAIM_BATCH) break;
    }
  }

  private async usageReceiver(tenant: string) {
    const row = (await this.db.query("select url, secret, previous, previous_until from usage_webhooks where tenant = $1", [tenant])).rows[0];
    return row && this.receiverOf(row, sealed => this.accounts.unseal(aad(tenant), sealed));
  }

  private async endpointReceiver(tenant: string, id: string) {
    const row = (await this.db.query("select url, secret, previous, previous_until from webhook_endpoints where tenant = $1 and id = $2", [tenant, id])).rows[0];
    return row && this.receiverOf(row, sealed => this.accounts.unseal(aad(tenant, id), sealed));
  }

  private receiverOf(row: any, unseal: (sealed: Sealed) => string): Receiver {
    const secrets = [unseal(row.secret)];
    if (row.previous && Number(row.previous_until) > Date.now()) secrets.push(unseal(row.previous));
    return { url: row.url as string, secrets };
  }

  /** Deliveries waiting in both outboxes, and how long the oldest has waited (a metric: metrics.ts). */
  async backlog(now = Date.now()) {
    const { rows } = await this.db.query(`
      select count(*)::int as pending, min(created_at) as oldest from (
        select created_at from webhook_deliveries union all select created_at from usage_webhook_outbox) as waiting`);
    return { pending: rows[0].pending as number, oldestAgeMs: rows[0].oldest === null ? 0 : Math.max(0, now - Number(rows[0].oldest)) };
  }

  private async deliver(table: string, row: { id: string; tenant: string; body: { id: string }; attempts: number; created_at: string | number }, receiver?: Receiver) {
    if (!receiver) { await this.db.query(`delete from ${table} where id = $1`, [row.id]); return; }
    const body = JSON.stringify(row.body);
    let failure: string;
    try {
      const response = await this.outbound.fetch(receiver.url, {
        method: "POST", body, timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024,
        headers: { "Content-Type": "application/json", ...signedHeaders(row.body.id, body, receiver.secrets) },
      });
      await response.arrayBuffer().catch(() => {});
      if (response.ok) {
        await this.db.query(`delete from ${table} where id = $1`, [row.id]);
        writeMetricLine(deliveryLine({ ...delivery(table, row), lagMs: Math.max(0, Date.now() - Number(row.created_at)) }));
        return;
      }
      failure = `HTTP ${response.status}`;
    } catch (error) { failure = errorText(error); }
    const delay = Math.min(60 * 60_000, this.retryBaseMs * 2 ** Math.min(row.attempts - 1, 20));
    await this.db.query(`update ${table} set due = $2, last_error = $3 where id = $1`, [row.id, Date.now() + delay, failure.slice(0, 500)]);
    writeMetricLine(deliveryLine({ ...delivery(table, row), lagMs: Math.max(0, Date.now() - Number(row.created_at)), error: failure }));
  }
}

/** Which webhook a delivery is for, and the facts its metric line carries. */
function delivery(table: string, row: { tenant: string; body: { id: string }; attempts: number }) {
  return { kind: table === "usage_webhook_outbox" ? "usage" as const : "endpoint" as const, tenant: row.tenant, event: row.body.id, attempts: row.attempts };
}
