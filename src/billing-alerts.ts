import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Accounts } from "./accounts.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";

/** Billing email consent and durable deliveries; deliberately independent of agent email channels. */
export type AlertChoices = { low: boolean; depleted: boolean; problems: boolean; receipts: boolean };
export type BillingRecipient = { id: string; email: string; status: "pending" | "verified" | "bounced" | "unsubscribed"; events: AlertChoices };
export type BillingAlertsView = { threshold: number; recipients: BillingRecipient[] };
type SecretStore = Pick<Accounts, "seal" | "unseal">;
const DEFAULT_CHOICES: AlertChoices = { low: true, depleted: true, problems: true, receipts: false };
const HOUR = 3_600_000, DAY = 24 * HOUR;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const aad = (id: string) => `billing-confirmation:${id}`;
const view = (r: any): BillingRecipient => ({ id: r.id, email: r.email, status: r.status,
  events: { low: r.low, depleted: r.depleted, problems: r.problems, receipts: r.receipts } });
function emailInput(value: string) {
  const email = value.trim().toLowerCase();
  if (!z.email().max(254).safeParse(email).success) throw new HttpError(400, "Enter a valid email address");
  return email;
}
function choicesInput(choices: AlertChoices) {
  if (Object.keys(DEFAULT_CHOICES).some(key => typeof choices[key as keyof AlertChoices] !== "boolean")) {
    throw new HttpError(400, "Choose each of low, depleted, problems and receipts");
  }
}

/**
 * All preference/recipient mutations lock the same balance row as the ledger.
 * Whichever transaction gets that lock first determines the event's recipients
 * and threshold. Never lock a recipient before the balance row.
 */
async function lockTenant(sql: Sql, tenant: string) {
  await sql.query("insert into credit_accounts (tenant) values ($1) on conflict (tenant) do nothing", [tenant]);
  await sql.query("select tenant from credit_accounts where tenant = $1 for update", [tenant]);
}

export class BillingAlerts {
  private readonly db: Db;
  private readonly secrets: SecretStore;
  constructor(db: Db, secrets: SecretStore) { this.db = db; this.secrets = secrets; }

  async get(tenant: string): Promise<BillingAlertsView> {
    const threshold = (await this.db.query("select threshold from billing_alert_settings where tenant = $1", [tenant])).rows[0]?.threshold ?? 2_000_000;
    const rows = (await this.db.query("select * from billing_recipients where tenant = $1 order by created_at, id", [tenant])).rows;
    const suppressed = new Set((await this.db.query("select email_hash from billing_email_suppressions where email_hash = any($1::text[])", [rows.map(r => sha(r.email))])).rows.map(r => r.email_hash));
    // A suppression can race an add on another tenant. The global record still
    // wins when displaying status, confirming consent, and claiming delivery.
    const recipients = rows.map(r => view({ ...r, status: suppressed.has(sha(r.email)) ? "bounced" : r.status }));
    return { threshold, recipients };
  }

  async setThreshold(tenant: string, threshold: number) {
    if (!Number.isSafeInteger(threshold) || threshold < 10_000 || threshold > 500_000_000 || threshold % 10_000) {
      throw new HttpError(400, "The alert threshold must be $0.01–$500, in whole cents");
    }
    await transaction(this.db, async sql => {
      await lockTenant(sql, tenant);
      const previous = (await sql.query("select threshold from billing_alert_settings where tenant = $1", [tenant])).rows[0]?.threshold ?? 2_000_000;
      await sql.query("insert into billing_alert_settings (tenant, threshold) values ($1, $2) on conflict (tenant) do update set threshold = excluded.threshold", [tenant, threshold]);
      const balance = (await sql.query("select balance from credit_accounts where tenant = $1", [tenant])).rows[0].balance;
      if (balance > 0 && balance >= previous && balance < threshold) {
        await sql.query("select billing_emit_event($1, 'billing.balance.low', $2, $3, 'low')", [tenant,
          { balance, threshold, source: "threshold_changed" }, `threshold:${randomUUID()}`]);
      }
    });
    return this.get(tenant);
  }

  async add(tenant: string, value: string, events: AlertChoices = DEFAULT_CHOICES, now = Date.now()): Promise<BillingRecipient> {
    const email = emailInput(value);
    choicesInput(events);
    return transaction(this.db, async sql => {
      await lockTenant(sql, tenant);
      const existing = (await sql.query("select * from billing_recipients where tenant = $1 and email = $2", [tenant, email])).rows[0];
      if (existing) return view(existing); // Retrying add never changes consent or sends again.
      if (Number((await sql.query("select count(*) from billing_recipients where tenant = $1", [tenant])).rows[0].count) >= 5) {
        throw new HttpError(400, "At most 5 billing email recipients are allowed");
      }
      if ((await sql.query("select 1 from billing_email_suppressions where email_hash = $1", [sha(email)])).rowCount) {
        throw new HttpError(400, "This email address cannot receive billing alerts; use another address");
      }
      await this.rateLimit(sql, tenant, email, now);
      const id = randomUUID(), token = randomBytes(32).toString("base64url");
      const row = (await sql.query(`insert into billing_recipients
        (id, tenant, email, low, depleted, problems, receipts, confirmation_hash, confirmation_expires, created_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [id, tenant, email, events.low, events.depleted, events.problems, events.receipts, sha(token), now + DAY, now])).rows[0];
      await this.queueConfirmation(sql, row, token, now);
      return view(row);
    });
  }

  async update(tenant: string, id: string, events: AlertChoices): Promise<BillingRecipient> {
    choicesInput(events);
    return transaction(this.db, async sql => {
      await lockTenant(sql, tenant);
      const previous = await this.recipient(sql, tenant, id);
      const row = (await sql.query(`update billing_recipients set low=$3, depleted=$4, problems=$5, receipts=$6
        where tenant=$1 and id=$2 returning *`, [tenant, id, events.low, events.depleted, events.problems, events.receipts])).rows[0];
      // Cancel now, rather than relying only on claim's check: a later opt-in
      // must not resurrect deliveries from before the opt-out.
      await sql.query(`update billing_email_outbox set state='cancelled'
        where recipient=$1 and state='pending' and
          ((kind='low' and not $2) or (kind='depleted' and not $3) or (kind='problems' and not $4) or (kind='receipts' and not $5))`,
      [id, events.low, events.depleted, events.problems, events.receipts]);
      if (row.status === "verified") await this.queueCurrent(sql, row, { low: !previous.low && events.low, depleted: !previous.depleted && events.depleted });
      return view(row);
    });
  }

  async remove(tenant: string, id: string) {
    return transaction(this.db, async sql => {
      await lockTenant(sql, tenant);
      // The FK removes unsent deliveries too. A send already in flight cannot be recalled.
      return !!(await sql.query("delete from billing_recipients where tenant = $1 and id = $2", [tenant, id])).rowCount;
    });
  }

  async resend(tenant: string, id: string, now = Date.now()) {
    return transaction(this.db, async sql => {
      await lockTenant(sql, tenant);
      const row = await this.recipient(sql, tenant, id);
      if (!["pending", "unsubscribed"].includes(row.status)) throw new HttpError(400, "Only an unconfirmed or unsubscribed address can receive a confirmation email");
      await this.rateLimit(sql, tenant, row.email, now);
      const token = randomBytes(32).toString("base64url");
      await sql.query("update billing_recipients set status='pending', confirmation_hash = $3, confirmation_expires = $4 where tenant = $1 and id = $2", [tenant, id, sha(token), now + DAY]);
      await sql.query("update billing_email_outbox set state = 'cancelled', secret = null where recipient = $1 and kind = 'confirmation' and state = 'pending'", [id]);
      await this.queueConfirmation(sql, { ...row, confirmation_hash: sha(token), confirmation_expires: now + DAY }, token, now);
    });
  }

  /** Read-only mailbox proof lookup. No account credential is issued by this flow. */
  async inspectConfirmation(token: string, now = Date.now()): Promise<
    { status: "unavailable" } | { status: "ready" | "confirmed"; tenant: string; email: string }
  > {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: "unavailable" };
    const row = (await this.db.query("select * from billing_recipients where confirmation_hash=$1 and confirmation_expires>$2", [sha(token), now])).rows[0];
    if (!row || !["pending", "verified"].includes(row.status) || (await this.db.query("select 1 from billing_email_suppressions where email_hash=$1", [sha(row.email)])).rowCount) return { status: "unavailable" };
    return { status: row.status === "verified" ? "confirmed" : "ready", tenant: row.tenant, email: row.email };
  }

  /** A token proves mailbox access, not tenant access. Invoke only on an explicit POST, never an email scanner's GET. */
  async confirm(token: string, now = Date.now()): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    return transaction(this.db, async sql => {
      const found = (await sql.query("select tenant from billing_recipients where confirmation_hash = $1", [sha(token)])).rows[0];
      if (!found) return false;
      await lockTenant(sql, found.tenant);
      const row = (await sql.query("select * from billing_recipients where confirmation_hash = $1 and confirmation_expires > $2", [sha(token), now])).rows[0];
      if (!row || !["pending", "verified"].includes(row.status)) return false;
      if ((await sql.query("select 1 from billing_email_suppressions where email_hash = $1", [sha(row.email)])).rowCount) return false;
      if (row.status === "verified") return true;
      await sql.query("update billing_recipients set status = 'verified' where id = $1", [row.id]);
      await sql.query("update billing_email_outbox set state = 'cancelled', secret = null where recipient = $1 and kind = 'confirmation' and state = 'pending'", [row.id]);
      await this.queueCurrent(sql, row, row);
      return true;
    });
  }

  /** Stable per-recipient capability. It only removes consent and never grants account access. */
  async unsubscribeToken(tenant: string, id: string): Promise<string> {
    return transaction(this.db, async sql => {
      await lockTenant(sql, tenant);
      const row = await this.recipient(sql, tenant, id);
      const context = `billing-unsubscribe:${id}`;
      if (row.unsubscribe_secret) return this.secrets.unseal(context, row.unsubscribe_secret);
      const token = randomBytes(32).toString("base64url");
      await sql.query("update billing_recipients set unsubscribe_hash=$2, unsubscribe_secret=$3 where id=$1", [id, sha(token), this.secrets.seal(context, token)]);
      return token;
    });
  }

  async inspectUnsubscribe(token: string): Promise<{ status: "unavailable" } | { status: "ready" | "unsubscribed"; tenant: string; email: string }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: "unavailable" };
    const row = (await this.db.query("select tenant,email,status from billing_recipients where unsubscribe_hash=$1", [sha(token)])).rows[0];
    if (!row) return { status: "unavailable" };
    return { status: row.status === "unsubscribed" ? "unsubscribed" : "ready", tenant: row.tenant, email: row.email };
  }

  /** POST only. Leaves other tenants' subscriptions alone and requires fresh mailbox consent to resume. */
  async unsubscribe(token: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    await transaction(this.db, async sql => {
      const found = (await sql.query("select tenant from billing_recipients where unsubscribe_hash=$1", [sha(token)])).rows[0];
      if (!found) return;
      await lockTenant(sql, found.tenant);
      const row = (await sql.query("update billing_recipients set status='unsubscribed', confirmation_expires=0 where unsubscribe_hash=$1 returning id", [sha(token)])).rows[0];
      if (row) await sql.query("update billing_email_outbox set state='cancelled', secret=null where recipient=$1 and state='pending'", [row.id]);
    });
  }

  /** Only call after authenticating provider bounce/complaint feedback. Suppression survives re-adding the address. */
  async suppress(value: string, now = Date.now()) {
    const email = emailInput(value);
    await transaction(this.db, async sql => {
      // Lock all affected balances in the same order, before touching recipients.
      const tenants = (await sql.query("select distinct tenant from billing_recipients where email = $1 order by tenant", [email])).rows;
      for (const row of tenants) await lockTenant(sql, row.tenant);
      await sql.query("insert into billing_email_suppressions (email_hash, created_at) values ($1,$2) on conflict do nothing", [sha(email), now]);
      await sql.query("update billing_recipients set status = 'bounced' where email = $1", [email]);
      await sql.query(`update billing_email_outbox set state = 'cancelled', secret = null
        where recipient in (select id from billing_recipients where email = $1) and state = 'pending'`, [email]);
    });
  }

  private async recipient(sql: Sql, tenant: string, id: string) {
    const row = (await sql.query("select * from billing_recipients where tenant = $1 and id = $2", [tenant, id])).rows[0];
    if (!row) throw new HttpError(404, "Unknown billing recipient");
    return row;
  }

  private async rateLimit(sql: Sql, tenant: string, email: string, now: number) {
    for (const [scope, maximum, cooldown] of [[`email:${sha(email)}`, 3, 60_000], [`tenant:${tenant}`, 10, 0]] as const) {
      await sql.query("insert into billing_confirmation_limits (scope, window_start, sent, last_sent) values ($1,$2,0,0) on conflict do nothing", [scope, now]);
      const row = (await sql.query("select * from billing_confirmation_limits where scope = $1 for update", [scope])).rows[0];
      const reset = now >= row.window_start + HOUR;
      if ((!reset && row.sent >= maximum) || (row.sent > 0 && now < row.last_sent + cooldown)) {
        throw new HttpError(429, "Please wait before sending another confirmation email");
      }
      await sql.query("update billing_confirmation_limits set window_start=$2, sent=$3, last_sent=$4 where scope=$1", [scope, reset ? now : row.window_start, reset ? 1 : row.sent + 1, now]);
    }
  }

  private async queueConfirmation(sql: Sql, row: any, token: string, now: number) {
    const id = randomUUID();
    await sql.query(`insert into billing_email_outbox (id, tenant, recipient, kind, payload, secret, expires_at, due, created_at)
      values ($1,$2,$3,'confirmation',$4,$5,$6,$7,$7)`,
    [id, row.tenant, row.id, { confirmationHash: row.confirmation_hash }, this.secrets.seal(aad(id), token), row.confirmation_expires, now]);
  }

  /** One current-state email when a recipient opts in. No global event, so existing recipients are not mailed again. */
  private async queueCurrent(sql: Sql, row: any, enabled: { low: boolean; depleted: boolean }) {
    const current = (await sql.query(`select a.balance, coalesce(s.threshold, 2000000) as threshold,
      exists(select 1 from credit_ledger where tenant = $1 and amount > 0) as funded
      from credit_accounts a left join billing_alert_settings s using (tenant) where a.tenant = $1`, [row.tenant])).rows[0];
    const kind = current.balance <= 0 ? (current.funded && enabled.depleted ? "depleted" : null)
      : current.balance < current.threshold && enabled.low ? "low" : null;
    if (!kind) return;
    const now = Date.now();
    // Repeated preference toggles must not keep mailing the same current state.
    if ((await sql.query(`select 1 from billing_email_outbox where recipient=$1 and kind=$2
      and state in ('pending','sent') and created_at>$3 limit 1`, [row.id, kind, now - DAY])).rowCount) return;
    await sql.query(`insert into billing_email_outbox (tenant, recipient, kind, payload, due, created_at)
      values ($1,$2,$3,$4,$5,$5)`, [row.tenant, row.id, kind,
    { type: `billing.balance.${kind}`, data: { balance: current.balance, threshold: current.threshold, source: "recipient_enabled" } }, now]);
  }

  /** Claim at most one batch. The opaque lease must accompany acknowledgement/retry, fencing expired workers. */
  async claim(now = Date.now(), limit = 25) {
    return transaction(this.db, async sql => {
      const rows = (await sql.query(`select o.*, r.email, r.status, r.confirmation_hash, r.low, r.depleted, r.problems, r.receipts
        from billing_email_outbox o join billing_recipients r on r.id = o.recipient
        where o.state = 'pending' and o.due <= $1 order by o.due, o.id
        limit $2 for update of o skip locked`, [now, Math.min(100, Math.max(1, Math.floor(limit)))])).rows;
      const claimed: { id: string; lease: string; tenant: string; recipient: string; email: string; kind: string; payload: any; token?: string; attempts: number }[] = [];
      for (const row of rows) {
        const suppressed = !!(await sql.query("select 1 from billing_email_suppressions where email_hash = $1", [sha(row.email)])).rowCount;
        const allowed = row.kind === "confirmation"
          ? row.status === "pending" && row.confirmation_hash === row.payload.confirmationHash && row.expires_at > now
          : row.status === "verified" && row[row.kind] === true;
        if (suppressed || !allowed || now >= row.created_at + 3 * DAY) {
          await sql.query("update billing_email_outbox set state = 'cancelled', secret = null where id = $1", [row.id]);
          continue;
        }
        const lease = randomUUID();
        await sql.query("update billing_email_outbox set lease=$2, due=$3, attempts=attempts+1 where id=$1", [row.id, lease, now + 60_000]);
        claimed.push({ id: row.id, lease, tenant: row.tenant, recipient: row.recipient, email: row.email, kind: row.kind,
          payload: row.kind === "confirmation" ? {} : row.payload,
          ...(row.secret ? { token: this.secrets.unseal(aad(row.id), row.secret) } : {}), attempts: row.attempts + 1 });
      }
      return claimed;
    });
  }

  async sent(id: string, lease: string, providerMessageId?: string) {
    return !!(await this.db.query("update billing_email_outbox set state='sent', secret=null, provider_message_id=$3 where id=$1 and lease=$2 and state='pending'", [id, lease, providerMessageId ?? null])).rowCount;
  }
  /** Re-check after token preparation: it may have waited behind a settings transaction. */
  async deliverable(id: string, lease: string, now = Date.now()) {
    return !!(await this.db.query(`select 1 from billing_email_outbox o join billing_recipients r on r.id=o.recipient
      where o.id=$1 and o.lease=$2 and o.state='pending' and o.due>$3
      and not exists (select 1 from billing_email_suppressions s where s.email_hash=encode(sha256(convert_to(r.email,'UTF8')),'hex'))
      and case o.kind when 'confirmation' then r.status='pending' and r.confirmation_hash=o.payload->>'confirmationHash' and o.expires_at>$4
        else r.status='verified' and case o.kind when 'low' then r.low when 'depleted' then r.depleted when 'problems' then r.problems when 'receipts' then r.receipts else false end end`,
    [id, lease, now + 20_000, now])).rowCount;
  }
  async retry(id: string, lease: string, now = Date.now()) {
    return !!(await this.db.query(`update billing_email_outbox set lease=null,
      due=$3 + least(3600000, 5000 * power(2, least(attempts, 10)))::bigint
      where id=$1 and lease=$2 and state='pending'`, [id, lease, now])).rowCount;
  }
}
