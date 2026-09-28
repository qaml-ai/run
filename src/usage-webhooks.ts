import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Accounts, Sealed } from "./accounts.ts";
import type { UsageRecord } from "./client-sessions.ts";
import type { Db, Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Outbound } from "./outbound.ts";
import { errorText } from "./protocol.ts";

/**
 * A tenant's webhook: its receiver gets the event types it selects, each a POST signed per Standard
 * Webhooks. `usage` is one per model response (turns and compaction summaries) with its usage and
 * cost, written to a Postgres outbox in the same transaction as the usage flush that counts it.
 * Lifecycle events (`run.started`, `run.finished`, `input.requested`, `input.resolved`) are written
 * to it as the run's record or the input's row becomes durable. Any node sends them, each claimed
 * by one node at a time, retrying with backoff until acknowledged, so delivery is at least once:
 * receivers dedupe by `id`, which a lifecycle event keeps when it is written again.
 */
export const WEBHOOK_EVENTS = ["usage", "run.started", "run.finished", "input.requested", "input.resolved"] as const;
export type WebhookEventType = typeof WEBHOOK_EVENTS[number];
/** An event for a tenant's webhook: its type, and what the type says. */
export type WebhookEvent = { id: string; type: WebhookEventType; tenant: string; at: number } & Record<string, unknown>;

export type UsageEvent = {
  id: string; type: "usage"; agent: string; requestId: string | null; tenant: string; subject: string; actor: string | null; context: Record<string, unknown>;
  keyScope: string | null; provider: string; model: string; kind: "response" | "compaction";
  input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number;
  cost: { usd: number; source: "provider" | "catalog" }; at: number;
};

const CLAIM_BATCH = 100;
/** A claimed event is left to others if its node has not settled it by then. */
const LEASE_MS = 60_000;
const TIMEOUT_MS = 10_000;
/** Undelivered events are dropped after this long. */
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;
/** A replaced secret keeps signing, beside the new one, for this long. */
const ROTATION_MS = 24 * 60 * 60_000;
const aad = (tenant: string) => `usage-webhook:${tenant}`;
const newSecret = () => `whsec_${randomBytes(24).toString("base64")}`;

/** A lifecycle event's id, the same each time it is written: a UUID from `key` (its type and what it is about). */
export function eventId(key: string) {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Add events to the outbox of each tenant whose webhook selects their type; one already there is left as it is. */
export async function enqueueEvents(sql: Sql, events: WebhookEvent[]) {
  if (!events.length) return;
  await sql.query(`
    insert into usage_webhook_outbox (id, tenant, body, due, created_at)
    select (e->>'id')::uuid, e->>'tenant', e, $2, $2 from jsonb_array_elements($1::jsonb) as e
    where exists (select 1 from usage_webhooks w where w.tenant = e->>'tenant' and e->>'type' = any(w.events))
    on conflict (id) do nothing`, [JSON.stringify(events), Date.now()]);
}

/** A webhook's event selection: known types, at least one, each once. */
function eventsInput(value: unknown): WebhookEventType[] {
  if (!Array.isArray(value) || !value.length || value.some(type => !WEBHOOK_EVENTS.includes(type)) || new Set(value).size !== value.length) {
    throw new HttpError(400, `events must list some of ${WEBHOOK_EVENTS.join(", ")}, each once`);
  }
  return value;
}

/** A model response's cost: the provider's own report when it made one (OpenRouter's), else the catalog price. */
export function usageCost(usage: any): { usd: number; source: "provider" | "catalog" } {
  return typeof usage?.providerCost === "number" ? { usd: usage.providerCost, source: "provider" } : { usd: Number(usage?.cost?.total) || 0, source: "catalog" };
}

/** The event for a model response, or undefined for other usage (web searches, renders, tool search). */
export function usageEvent(tenant: string, agent: string, message: UsageRecord): UsageEvent | undefined {
  if (message.searches || message.renders || message.toolSearch) return undefined;
  const usage = message.usage ?? {};
  // A tenant endpoint's calls are named as its agents name the model: `chiridion` / `openai-codex/gpt-5.5`.
  const [provider, ...upstream] = (message.provider ?? "unknown").split("/");
  const model = [...upstream, message.model ?? "unknown"].join("/");
  return {
    id: randomUUID(), type: "usage", agent, requestId: message.requestId ?? null, tenant, subject: message.identity?.subject ?? agent, actor: message.actor ?? null,
    context: message.identity?.context ?? {}, keyScope: message.keyScope ?? null, provider, model,
    kind: message.kind === "compaction" ? "compaction" : "response",
    input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0,
    ...(typeof usage.reasoning === "number" ? { reasoning: usage.reasoning } : {}), cost: usageCost(usage), at: message.timestamp ?? Date.now(),
  };
}

/** Standard Webhooks headers for `body`, signed with each secret (`whsec_<base64 key>`). */
export function signedHeaders(id: string, body: string, secrets: string[], now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  const signatures = secrets.map(secret => `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`);
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signatures.join(" ") };
}

export class UsageWebhooks {
  private readonly db: Db;
  private readonly accounts: Accounts;
  private readonly outbound: Outbound;
  private readonly retryBaseMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private sending = false;

  constructor(options: { db: Db; accounts: Accounts; outbound: Outbound; retryBaseMs?: number }) {
    this.db = options.db;
    this.accounts = options.accounts;
    this.outbound = options.outbound;
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
  }

  async get(tenant: string) {
    const row = (await this.db.query("select url, events, created_at from usage_webhooks where tenant = $1", [tenant])).rows[0];
    return row && { url: row.url as string, events: row.events as WebhookEventType[], createdAt: Number(row.created_at) };
  }

  /**
   * Set the receiver, and the event types it gets: a new one gets `usage` unless it says, and
   * `events` left out keeps the current selection. A tenant's first one gets a signing secret, returned only now.
   */
  async set(tenant: string, url: unknown, events?: unknown) {
    if (typeof url !== "string") throw new HttpError(400, "url must be a string");
    try { this.outbound.check(url); } catch (error) { throw new HttpError(400, errorText(error)); }
    const selected = events === undefined ? null : eventsInput(events);
    const secret = newSecret();
    const { rows } = await this.db.query(`
      insert into usage_webhooks (tenant, url, secret, created_at, events) values ($1, $2, $3, $4, coalesce($5, '{usage}'::text[]))
      on conflict (tenant) do update set url = excluded.url, events = coalesce($5, usage_webhooks.events) returning (xmax = 0) as created, events`,
      [tenant, url, this.accounts.seal(aad(tenant), secret), Date.now(), selected]);
    return { url, events: rows[0].events as WebhookEventType[], ...(rows[0].created ? { secret } : {}) };
  }

  /** A new signing secret, returned only now; the old one also signs for a day, so receivers can switch. */
  async rotate(tenant: string) {
    const secret = newSecret();
    const { rowCount } = await this.db.query("update usage_webhooks set previous = secret, previous_until = $3, secret = $2 where tenant = $1",
      [tenant, this.accounts.seal(aad(tenant), secret), Date.now() + ROTATION_MS]);
    if (!rowCount) throw new HttpError(404, "No usage webhook is set");
    return { secret };
  }

  /** Remove the receiver, and the events still waiting for it. */
  async delete(tenant: string) {
    const { rowCount } = await this.db.query("delete from usage_webhooks where tenant = $1", [tenant]);
    await this.db.query("delete from usage_webhook_outbox where tenant = $1", [tenant]);
    return !!rowCount;
  }

  start(intervalMs = 5_000) {
    this.timer ??= setInterval(() => void this.send().catch(error => console.error(JSON.stringify({ type: "usage_webhook_scan_failed", error: errorText(error) }))), intervalMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** Send every due event, claiming batches so no two nodes send one at once. */
  async send(now = Date.now()) {
    if (this.sending) return;
    this.sending = true;
    try {
      await this.db.query("delete from usage_webhook_outbox where created_at < $1", [now - MAX_AGE_MS]);
      for (;;) {
        const { rows } = await this.db.query(`
          update usage_webhook_outbox set due = $2, attempts = attempts + 1
          where id in (select id from usage_webhook_outbox where due <= $1 order by due limit ${CLAIM_BATCH} for update skip locked)
          returning id, tenant, body, attempts`, [Date.now(), Date.now() + LEASE_MS]);
        const receivers = new Map<string, Promise<{ url: string; secrets: string[] } | undefined>>();
        await Promise.all(rows.map(async row => {
          if (!receivers.has(row.tenant)) receivers.set(row.tenant, this.receiver(row.tenant));
          await this.deliver(row, await receivers.get(row.tenant));
        }));
        if (rows.length < CLAIM_BATCH) break;
      }
    } finally { this.sending = false; }
  }

  private async receiver(tenant: string) {
    const row = (await this.db.query("select url, secret, previous, previous_until from usage_webhooks where tenant = $1", [tenant])).rows[0];
    if (!row) return undefined;
    const secrets = [this.accounts.unseal(aad(tenant), row.secret as Sealed)];
    if (row.previous && Number(row.previous_until) > Date.now()) secrets.push(this.accounts.unseal(aad(tenant), row.previous as Sealed));
    return { url: row.url as string, secrets };
  }

  private async deliver(row: { id: string; tenant: string; body: WebhookEvent; attempts: number }, receiver?: { url: string; secrets: string[] }) {
    if (!receiver) { await this.db.query("delete from usage_webhook_outbox where id = $1", [row.id]); return; }
    const body = JSON.stringify(row.body);
    let failure: string;
    try {
      const response = await this.outbound.fetch(receiver.url, {
        method: "POST", body, timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024,
        headers: { "Content-Type": "application/json", ...signedHeaders(row.body.id, body, receiver.secrets) },
      });
      await response.arrayBuffer().catch(() => {});
      if (response.ok) { await this.db.query("delete from usage_webhook_outbox where id = $1", [row.id]); return; }
      failure = `HTTP ${response.status}`;
    } catch (error) { failure = errorText(error); }
    const delay = Math.min(60 * 60_000, this.retryBaseMs * 2 ** Math.min(row.attempts - 1, 20));
    await this.db.query("update usage_webhook_outbox set due = $2, last_error = $3 where id = $1", [row.id, Date.now() + delay, failure.slice(0, 500)]);
    console.error(JSON.stringify({ type: "usage_webhook_failed", tenant: row.tenant, event: row.id, attempts: row.attempts, error: failure }));
  }
}
