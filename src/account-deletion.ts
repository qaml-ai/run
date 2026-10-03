import type { Accounts } from "./accounts.ts";
import type { Channels } from "./channels.ts";
import { transaction, type Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { safeError } from "./metrics.ts";
import { StripeError, type Stripe } from "./stripe.ts";
import type { VolumeService } from "./volumes.ts";
import type { Storage } from "../shared/storage.ts";

/**
 * Deleting a tenant created by sign-in, and everything it stored: agents (through their purge, which releases their
 * chunk pins), volumes and their files, credentials (API tokens, OAuth grants, provider keys, key scopes), definitions,
 * webhooks, channels, billing contacts and settings, its Stripe customer, and its tenant row.
 *
 * Kept, on purpose: the credit ledger, credit account and usage totals (for tax and accounting), payment records
 * (checkouts, automatic top-ups, refunds, which Stripe customer paid), and the starting-credit records that stop an
 * identity or card claiming credit twice (`starting_credit_decisions`, by GitHub id; `card_checks`, by card
 * fingerprint). They stay keyed by the deleted tenant's id, which is never given to a new tenant.
 *
 * A request (`request`) takes effect at once: the tenant stops authenticating, and sign-in no longer finds it, so
 * the same GitHub or Google account signs up afresh (without new starting credit). The rest runs in the background
 * on whichever node claims it (`account_deletions`, with a lease), each step idempotent, so a deletion that fails or
 * whose node dies continues where it stopped on the next attempt. Admin tenants (the tenants file) are never deleted
 * here: they are removed from that file.
 */
export interface DeletionStatus { tenant: string; state: "deleting" | "deleted"; requestedAt: number; completedAt: number | null; agents?: number }

export interface AccountDeletionOptions {
  db: Db;
  accounts: Accounts;
  storage: Storage;
  volumes?: VolumeService;
  channels?: Channels;
  stripe?: Stripe;
  /** Delete one of the tenant's agents on whichever node serves it. */
  deleteAgent(agent: string, tenant: string): Promise<unknown>;
  /** Purge deleted agents now, rather than at the next sweep. */
  purgeAgents?(): Promise<void>;
  /** Write storage-usage deltas, so none for the tenant's deleted objects is written after its rows go. */
  flushStorageUsage?(): Promise<void>;
}

/** Tables whose rows go with the tenant, by their `tenant` column (payment, ledger and anti-abuse records are not here). */
const TENANT_TABLES = [
  "discord_setup_attempts", "discord_server_bindings",
  "api_tokens", "oauth_grants", "provider_keys", "key_scope_providers", "model_providers", "definitions",
  "webhook_deliveries", "webhook_endpoints", "usage_webhook_outbox", "usage_webhooks", "telemetry_exporters", "idempotency_keys",
  "agent_inputs", "schedules", "channel_agents", "volume_watchers", "channels",
  "chunk_pins", "chunk_touches", "gc_candidates", "storage_gc",
  "billing_email_outbox", "billing_recipients", "billing_events", "billing_alert_settings", "billing_auto_settings", "help_requests",
];

export class AccountDeletions {
  private readonly options: AccountDeletionOptions;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(options: AccountDeletionOptions) { this.options = options; }

  private get db() { return this.options.db; }

  /**
   * Start deleting `tenant`; a deletion already started is returned as it stands. The tenant stops authenticating now.
   * Refused while an automatic top-up payment is in flight, which would charge a card for a deleted account.
   */
  async request(tenant: string, by: string): Promise<DeletionStatus> {
    if (this.options.accounts.tenants.has(tenant)) throw new HttpError(403, "Admin tenants are defined in the tenants file: remove them there");
    const existing = await this.status(tenant);
    if (existing) { this.kick(); return existing; }
    await transaction(this.db, async sql => {
      if (!(await sql.query("select 1 from tenants where id = $1 for update", [tenant])).rowCount) throw new HttpError(404, `Unknown tenant ${tenant}`);
      if ((await sql.query("select 1 from billing_auto_attempts where tenant = $1 and state not in ('paid', 'cancelled')", [tenant])).rowCount) {
        throw new HttpError(409, "An automatic top-up payment is in progress; try again once it has settled");
      }
      await sql.query("insert into account_deletions (tenant, requested_at, requested_by) values ($1, $2, $3) on conflict do nothing", [tenant, Date.now(), by]);
      // Sign-in no longer finds the tenant: the same GitHub or Google account now signs up as a new one.
      await sql.query("update tenants set github = null, github_id = null, google_sub = null, google_email = null where id = $1", [tenant]);
      await sql.query("update billing_auto_settings set enabled = false where tenant = $1", [tenant]);
    });
    this.options.accounts.forget(tenant);
    console.log(JSON.stringify({ type: "account_deletion_requested", tenant, by }));
    this.kick();
    return (await this.status(tenant))!;
  }

  async status(tenant: string): Promise<DeletionStatus | undefined> {
    const row = (await this.db.query("select requested_at, completed_at from account_deletions where tenant = $1", [tenant])).rows[0];
    if (!row) return undefined;
    if (row.completed_at !== null) return { tenant, state: "deleted", requestedAt: row.requested_at, completedAt: row.completed_at };
    const agents = Number((await this.db.query("select count(*) from agents where tenant = $1", [tenant])).rows[0].count);
    return { tenant, state: "deleting", requestedAt: row.requested_at, completedAt: null, agents };
  }

  /** Run deletions that are due until none is left; one already running here takes new work itself. */
  kick(): Promise<void> {
    return this.running ??= (async () => {
      try { while (await this.next()); }
      catch (error) { console.error(JSON.stringify({ type: "account_deletion_sweep_failed", error: safeError(error) })); }
      finally { this.running = undefined; }
    })();
  }

  start(pollMs = 5_000) {
    this.timer ??= setInterval(() => void this.kick(), pollMs);
    this.timer.unref();
  }

  /** Take no more; a deletion running here that is cut short is continued by another node once its lease lapses. */
  stop() { clearInterval(this.timer); this.timer = undefined; }

  /** Claim one deletion that is due, with a lease, and take it as far as it goes; false when none was due. */
  async next(): Promise<boolean> {
    const { rows } = await this.db.query(`
      update account_deletions set claimed_until = now() + interval '5 minutes', attempts = attempts + 1
      where tenant = (select tenant from account_deletions where completed_at is null and (claimed_until is null or claimed_until < now())
        order by requested_at limit 1 for update skip locked)
      returning tenant`);
    const tenant = rows[0]?.tenant as string | undefined;
    if (!tenant) return false;
    let retryMs = 60_000;
    try {
      // Agents are purged by the sweep: until they all are, look again shortly.
      if (!await this.run(tenant)) retryMs = 2_000;
      else return true;
    } catch (error) {
      console.error(JSON.stringify({ type: "account_deletion_failed", tenant, error: safeError(error) }));
    }
    await this.db.query("update account_deletions set claimed_until = now() + $2 * interval '1 millisecond' where tenant = $1", [tenant, retryMs]);
    return true;
  }

  /** Every step, in order, each safe to repeat; false while the tenant's agents are still being purged. */
  private async run(tenant: string): Promise<boolean> {
    const { db, channels, volumes } = this.options;
    const ids = async (query: string) => (await db.query(query, [tenant])).rows.map(row => row.id as string);
    // Channels first, so no message makes the tenant a new agent meanwhile; each is torn down at its provider.
    for (const id of await ids("select id from channels where tenant = $1")) {
      if (channels) await channels.remove(tenant, id, { managed: true });
      await db.query("delete from channel_conversations where channel = $1", [id]);
    }
    // Agents are revoked where they run, then purged (their logs, history, files' pins, schedules and threads).
    for (const id of await ids("select id from agents where tenant = $1 and not revoked")) await this.options.deleteAgent(id, tenant);
    // A purged agent's tombstone no longer names its tenant.
    if ((await db.query("select 1 from agents where tenant = $1 limit 1", [tenant])).rowCount) {
      await this.options.purgeAgents?.();
      if ((await db.query("select 1 from agents where tenant = $1 limit 1", [tenant])).rowCount) return false;
    }
    if (volumes) {
      for (const id of await ids("select id from volumes where tenant = $1 and deleted_at is null")) {
        await volumes.call(id, tenant, "delete").catch(error => { if ((error as HttpError).status !== 404) throw error; });
      }
      for (const id of await ids("select id from volumes where tenant = $1 and purged_at is null")) await volumes.purge(id);
    }
    // Files' contents: every chunk the tenant stored, referenced or not.
    await this.options.storage.removeBlobs(`chunks/${tenant}/`);
    await this.options.flushStorageUsage?.();
    await this.deleteCustomers(tenant);
    await transaction(db, async sql => {
      for (const table of TENANT_TABLES) await sql.query(`delete from ${table} where tenant = $1`, [tenant]);
      await sql.query("delete from billing_confirmation_limits where scope = $1", [`tenant:${tenant}`]);
      await sql.query("delete from storage_usage where (kind = 'tenant' and owner = $1) or (kind = 'volume' and owner in (select id from volumes where tenant = $1))", [tenant]);
      await sql.query("delete from volumes where tenant = $1", [tenant]);
      await sql.query("delete from tenants where id = $1", [tenant]);
      await sql.query("update account_deletions set completed_at = $2, claimed_until = null where tenant = $1", [tenant, Date.now()]);
    });
    this.options.accounts.billing.invalidate([tenant]);
    console.log(JSON.stringify({ type: "account_deleted", tenant }));
    return true;
  }

  /**
   * Delete the tenant's Stripe customers, after expiring its open checkouts. Deleting a customer detaches its saved
   * cards and cannot be undone; Stripe keeps the payments, invoices and refunds made, which accounting needs.
   */
  private async deleteCustomers(tenant: string) {
    const stripe = this.options.stripe;
    if (!stripe) return;
    const { rows: open } = await this.db.query("select session from billing_checkouts where tenant = $1 and livemode = $2 and session is not null and paid_at is null", [tenant, stripe.live]);
    for (const { session } of open) {
      await stripe.post(`/v1/checkout/sessions/${encodeURIComponent(session)}/expire`, {}).catch(error => {
        // Already complete or expired.
        if (!(error instanceof StripeError && error.status >= 400 && error.status < 500)) throw error;
      });
    }
    const { rows } = await this.db.query(`
      select customer from billing_stripe_customers where tenant = $1 and livemode = $2 and customer is not null
      union select stripe_customer from credit_accounts where tenant = $1 and stripe_customer is not null`, [tenant, stripe.live]);
    for (const { customer } of rows) {
      await stripe.delete(`/v1/customers/${encodeURIComponent(customer)}`).catch(error => {
        // Deleted already, or one of the other Stripe mode's.
        if (!(error instanceof StripeError && error.status === 404)) throw error;
      });
    }
  }
}
