import { createHash, createHmac, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import type { Accounts } from "./accounts.ts";
import type { BillingAlerts } from "./billing-alerts.ts";
import type { billingMailConfig } from "./billing-mailer.ts";
import { transaction, type Db } from "./db.ts";
import { errorText } from "./protocol.ts";
import { helpSupportEmail, helpThreadEmail, type HelpMessage, type HelpSnapshot } from "./help-emails.ts";
import type { MailResult, OutgoingMail } from "./mail-transport.ts";
import { HELP_CATEGORIES, HELP_IMPACTS, HELP_LIMITS, HELP_METHODS, HELP_ROUTE_TEMPLATES, type HelpErrorCode, type HelpFailure } from "../shared/help-contract.ts";

/**
 * Get Help (POST /v1/help, from the console). A submission sends two emails at once: one to
 * support alone with what helps investigate, and a thread to support copying the user with only
 * what they wrote. Each submission id is reserved once, so a retry sends only the email not yet
 * accepted. Providers take no idempotency key: a crash just after one accepts a message can still
 * send that message twice.
 */
export const HELP_WINDOW_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
/** Submissions allowed per window: a tenant's, a source address's, and (per day) a reply address's. */
export const HELP_LIMITS_PER = { tenant: 5, tenantDay: 20, source: 20, emailDay: 5 };
const LEASE_SECONDS = 120;
const SEND_TIMEOUT_MS = 15_000;

export interface HelpConfig {
  /** The support inbox: both emails go there. */
  inbox: string;
  from: string;
  displayName: string;
  /** The runtime's public origin, for the logo and the host shown to support. */
  origin: string;
  release?: string;
  logGroup?: string;
  transport: { from: string; displayName: string; region?: string; configurationSet?: string; cloudflare?: { url: string; secret: string } };
}

/**
 * Get Help is on only when the support inbox and its sender are both set: a self-hosted runtime never
 * mails camelAI by default. It sends through the billing email provider (AGENT_BILLING_EMAIL_*).
 */
export function helpConfig(env: NodeJS.ProcessEnv, mail: ReturnType<typeof billingMailConfig>): HelpConfig | undefined {
  const inbox = env.AGENT_SUPPORT_EMAIL?.trim(), from = env.AGENT_SUPPORT_EMAIL_FROM?.trim();
  if (!inbox && !from) return undefined;
  if (!inbox || !from) throw new Error("Get Help needs both AGENT_SUPPORT_EMAIL (the support inbox) and AGENT_SUPPORT_EMAIL_FROM (the verified sender)");
  if (!z.email().safeParse(inbox).success || !z.email().safeParse(from).success) throw new Error("AGENT_SUPPORT_EMAIL and AGENT_SUPPORT_EMAIL_FROM must be email addresses");
  if (!mail) throw new Error("Get Help sends through the billing email provider: configure AGENT_BILLING_EMAIL_FROM and its provider too");
  if (from.toLowerCase() === mail.from.toLowerCase()) throw new Error("AGENT_SUPPORT_EMAIL_FROM must differ from AGENT_BILLING_EMAIL_FROM");
  const displayName = env.AGENT_SUPPORT_EMAIL_NAME ?? "camelRun";
  if (!displayName.trim() || displayName.length > 80 || /[\r\n]/.test(displayName)) throw new Error("AGENT_SUPPORT_EMAIL_NAME must be a single display name, at most 80 characters");
  const release = env.AGENT_RELEASE && /^[\w.:@+-]{1,128}$/.test(env.AGENT_RELEASE) ? env.AGENT_RELEASE : undefined;
  return { inbox, from, displayName, origin: mail.origin, release, logGroup: env.AGENT_SUPPORT_LOG_GROUP || undefined,
    transport: { from, displayName, region: mail.region, configurationSet: mail.configurationSet, cloudflare: mail.cloudflare } };
}

export interface HelpOptions extends HelpConfig {
  db: Db;
  accounts: Accounts;
  send: (mail: OutgoingMail, signal: AbortSignal) => Promise<MailResult>;
  /** Verified billing addresses are the ones a reply may go to, when a tenant has any. */
  alerts?: Pick<BillingAlerts, "get" | "suppress">;
  /** Keys the hashes of reply addresses and source addresses kept for rate limits. */
  hashKey: string;
  now?: () => number;
}
export interface HelpCaller { tenant: string; login?: string }
export interface HelpReply { status: number; body: { success: true; reference: string } | { error: string; code: HelpErrorCode }; retryAfter?: number }

type Channel = "internal" | "thread";
type Reservation =
  | { status: "accepted"; lease: string; snapshot: HelpSnapshot; sent: Record<Channel, boolean> }
  | { status: "delivered" } | { status: "in_progress" } | { status: "payload_mismatch" } | { status: "rate_limited"; retryAfter: number }
  | { status: "unknown_email" };

// IDs go into a log query and an email: printable ASCII without quotes, backslashes or spaces.
const ID = /^[!#-[\]-~]+$/;
const Submission = z.object({
  submissionId: z.uuid("Invalid help request"),
  email: z.string("Enter your email address").trim().max(HELP_LIMITS.email, "That email address is too long"),
  category: z.enum(HELP_CATEGORIES, "Choose a category"),
  impact: z.enum(HELP_IMPACTS, "Choose how much this affects you").optional(),
  description: z.string("Describe what you need help with").trim().min(1, "Describe what you need help with")
    .max(HELP_LIMITS.description, `Keep the description to ${HELP_LIMITS.description} characters`),
  agentId: z.string().trim().max(HELP_LIMITS.agentId, "That agent ID is too long").optional(),
  requestId: z.string().trim().max(HELP_LIMITS.requestId, "That request ID is too long").optional(),
  context: z.unknown().optional(),
});

const ok = (reference: string): HelpReply => ({ status: 200, body: { success: true, reference } });
const fail = (status: number, code: HelpErrorCode, error: string, retryAfter?: number): HelpReply => ({ status, body: { error, code }, ...(retryAfter ? { retryAfter } : {}) });
export const helpReference = (id: string) => `R-${id.replaceAll("-", "").slice(0, 8).toUpperCase()}`;

export class Help {
  private readonly options: HelpOptions;
  constructor(options: HelpOptions) { this.options = options; }
  private now() { return this.options.now?.() ?? Date.now(); }
  private hash(kind: string, value: string) { return createHmac("sha256", this.options.hashKey).update(`help-${kind}:${value}`).digest("hex"); }

  /** The tenant's verified billing addresses, oldest first, leaving out suppressed ones: replies go to one of these when there are any. */
  async replyEmails(tenant: string): Promise<string[]> {
    if (!this.options.alerts) return [];
    const { recipients } = await this.options.alerts.get(tenant);
    return [...new Set(recipients.filter(recipient => recipient.status === "verified").map(recipient => recipient.email.toLowerCase()))];
  }

  async submit(caller: HelpCaller, body: unknown, request: { userAgent?: string; source?: string } = {}): Promise<HelpReply> {
    const parsed = this.parse(body);
    if ("error" in parsed) return fail(400, "INVALID_REQUEST", parsed.error);
    const { submissionId: id, message } = parsed;
    const emailKey = message.email.toLowerCase();
    const payload = createHash("sha256").update(JSON.stringify([caller.tenant, emailKey, message.category, message.impact ?? null, message.description,
      message.agentId ?? null, message.requestId ?? null, message.client])).digest("hex");
    const reservation = await this.reserve(id, caller.tenant, emailKey, message.reference, payload, this.hash("email", emailKey),
      request.source ? this.hash("source", request.source) : null, verified => this.collect(caller, message, verified, request.userAgent));
    if (reservation.status === "unknown_email") return fail(400, "INVALID_REQUEST", "Choose one of the verified email addresses on file for this account.");
    if (reservation.status === "delivered") return ok(message.reference);
    if (reservation.status === "in_progress") return fail(409, "HELP_IN_PROGRESS", "This help request is already being sent.", 5);
    if (reservation.status === "payload_mismatch") return fail(409, "HELP_PAYLOAD_MISMATCH", "This help request changed after it was first sent. Send it again as a new request.");
    if (reservation.status === "rate_limited") return fail(429, "RATE_LIMITED", "Too many help requests. Please wait a few minutes and try again.", reservation.retryAfter);

    const { lease, snapshot, sent } = reservation;
    // Failures are shown as of the first attempt, so a retry's payload (and its hash) never changes with the clock.
    const shown = { ...message, client: { ...message.client, failures: message.client.failures.filter(failure => {
      const at = Date.parse(failure.at);
      return at > snapshot.submittedAt - DAY_MS && at < snapshot.submittedAt + 5 * 60_000;
    }) } };
    const { inbox } = this.options;
    const copy = emailKey === inbox.toLowerCase() ? undefined : message.email;
    const tags = [{ Name: "product", Value: "camelrun-support" }, { Name: "help_request", Value: id }];
    const mails: [Channel, OutgoingMail][] = [];
    if (!sent.internal) mails.push(["internal", { to: inbox, replyTo: inbox, tags, ...helpSupportEmail(snapshot, shown) }]);
    if (!sent.thread) mails.push(["thread", { to: inbox, ...(copy ? { cc: copy } : {}), replyTo: inbox, tags, ...helpThreadEmail(message, this.options.origin) }]);
    const results = await Promise.allSettled(mails.map(async ([channel, mail]) => {
      const result = await this.options.send(mail, AbortSignal.timeout(SEND_TIMEOUT_MS));
      if ("suppressed" in result) return "suppressed" as const;
      await this.accepted(id, channel, result.messageId);
      return "sent" as const;
    }));
    results.forEach((result, i) => {
      if (result.status === "fulfilled" && result.value === "sent") return;
      // No addresses, content or provider bodies in logs.
      console.error(JSON.stringify({ type: "help_mail_failed", reference: message.reference, channel: mails[i][0],
        reason: result.status === "fulfilled" ? result.value : "error" }));
    });
    if (results.every(result => result.status === "fulfilled" && result.value === "sent")) {
      await this.finish(id, lease, "delivered").catch(error => console.error(JSON.stringify({ type: "help_state_failed", reference: message.reference, error: errorText(error) })));
      return ok(message.reference);
    }
    await this.finish(id, lease, "failed").catch(error => console.error(JSON.stringify({ type: "help_state_failed", reference: message.reference, error: errorText(error) })));
    const outcome = (channel: Channel) => results.find((_, i) => mails[i][0] === channel);
    const delivered = (channel: Channel) => { const result = outcome(channel); return result?.status === "fulfilled" && result.value === "sent"; };
    const thread = outcome("thread");
    // The support inbox took the other message, so the address refused is the user's: forget it as a saved address too.
    if (copy && thread?.status === "fulfilled" && thread.value === "suppressed" && (sent.internal || delivered("internal"))) {
      await this.options.alerts?.suppress(copy).catch(error => console.error(JSON.stringify({ type: "help_suppress_failed", reference: message.reference, error: errorText(error) })));
      return fail(422, "HELP_RECIPIENT_SUPPRESSED", `We can't email ${message.email}: messages to it have bounced or been marked as spam. Use another address.`);
    }
    return fail(503, "HELP_DELIVERY_FAILED", "We couldn't send your help request. Please try again.", 5);
  }

  /** The form, validated, and the console's context, reduced to what the contract allows. */
  private parse(body: unknown): { submissionId: string; message: HelpMessage } | { error: string } {
    const result = Submission.safeParse(body);
    if (!result.success) return { error: result.error.issues[0].message };
    const input = result.data;
    if (!z.email().safeParse(input.email).success) return { error: "Enter a valid email address" };
    if (input.category === "bug" && !input.impact) return { error: "Choose how much this affects you" };
    const agentId = input.agentId || undefined, requestId = input.requestId || undefined;
    if (agentId && !ID.test(agentId)) return { error: "Enter the agent's ID or key as the console shows it" };
    if (requestId && !ID.test(requestId)) return { error: "Enter the request ID as the API returned it" };
    return { submissionId: input.submissionId.toLowerCase(), message: {
      reference: helpReference(input.submissionId), email: input.email, category: input.category,
      ...(input.category === "bug" ? { impact: input.impact } : {}), description: input.description,
      ...(agentId ? { agentId } : {}), ...(requestId ? { requestId } : {}), client: this.clientContext(input.context),
    } };
  }

  /** Whatever of the console's context is well formed; anything else is left out rather than refused. */
  private clientContext(value: unknown): HelpMessage["client"] {
    const context = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const string = (key: string, pattern: RegExp, max: number) => typeof context[key] === "string" && (context[key] as string).length <= max && pattern.test(context[key] as string) ? context[key] as string : undefined;
    const rawPage = typeof context.page === "string" ? context.page.split(/[?#]/, 1)[0] : undefined;
    const page = rawPage && rawPage.length <= HELP_LIMITS.page && /^\/console(\/[\w.~-]*)*$/.test(rawPage) ? rawPage : undefined;
    let timezone = string("timezone", /^[A-Za-z0-9_+\-/]+$/, 64);
    try { if (timezone) new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { timezone = undefined; }
    const failures: HelpFailure[] = [];
    for (const entry of Array.isArray(context.failures) ? context.failures.slice(0, 20) : []) {
      if (failures.length >= HELP_LIMITS.failures || !entry || typeof entry !== "object") continue;
      const { method, path, status, at } = entry as Record<string, unknown>;
      const time = typeof at === "string" ? Date.parse(at) : NaN;
      if (!HELP_METHODS.includes(method as never) || !HELP_ROUTE_TEMPLATES.includes(path as never) || !Number.isInteger(status) ||
        (status as number) < 0 || (status as number) > 599 || !Number.isFinite(time)) continue;
      failures.push({ method: method as string, path: path as string, status: status as number, at: new Date(time).toISOString() });
    }
    const viewport = string("viewport", /^\d{1,5}x\d{1,5}$/, 11), build = string("build", /^[\w.+-]+$/, 64);
    return { ...(page ? { page } : {}), ...(viewport ? { viewport } : {}), ...(timezone ? { timezone } : {}), ...(build ? { build } : {}), failures };
  }

  /**
   * Take the submission's lease. A new one is counted against the rate limits under advisory locks, so
   * concurrent submissions cannot overrun them; a retry of the same submission reuses its row and quota.
   */
  private async reserve(id: string, tenant: string, emailKey: string, reference: string, payload: string, emailHash: string, sourceHash: string | null,
    collect: (verified: boolean) => Promise<HelpSnapshot>): Promise<Reservation> {
    const { db } = this.options;
    if (!(await db.query("select 1 from help_requests where id = $1", [id])).rowCount) {
      // A new request replies to a verified address when the tenant has one. A retry keeps the address it started with.
      const known = await this.replyEmails(tenant);
      if (known.length && !known.includes(emailKey)) return { status: "unknown_email" };
      const snapshot = await collect(known.includes(emailKey));
      const created = await transaction(db, async sql => {
        for (const key of [`tenant:${tenant}`, `email:${emailHash}`, ...(sourceHash ? [`source:${sourceHash}`] : [])].sort()) {
          await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`help-requests:${key}`]);
        }
        if ((await sql.query("select 1 from help_requests where id = $1", [id])).rowCount) return undefined;
        const now = this.now();
        const { rows: [counts] } = await sql.query(`select
            count(*) filter (where tenant = $1 and created_at > $4) as tenant,
            count(*) filter (where tenant = $1) as tenant_day,
            count(*) filter (where email_hash = $2) as email_day,
            count(*) filter (where source_hash = $3 and created_at > $4) as source
          from help_requests where created_at > $5 and (tenant = $1 or email_hash = $2 or source_hash = $3)`,
        [tenant, emailHash, sourceHash, now - HELP_WINDOW_MS, now - DAY_MS]);
        const limits = HELP_LIMITS_PER;
        if (counts.tenant >= limits.tenant || counts.source >= limits.source) return { status: "rate_limited" as const, retryAfter: HELP_WINDOW_MS / 1000 };
        if (counts.tenant_day >= limits.tenantDay || counts.email_day >= limits.emailDay) return { status: "rate_limited" as const, retryAfter: 3600 };
        const lease = randomUUID();
        await sql.query(`insert into help_requests (id, tenant, reference, payload_sha256, email_hash, source_hash, snapshot, status, lease, leased_until, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, now() + make_interval(secs => $9), $10, $10)`,
        [id, tenant, reference, payload, emailHash, sourceHash, JSON.stringify(snapshot), lease, LEASE_SECONDS, now]);
        return { status: "accepted" as const, lease, snapshot, sent: { internal: false, thread: false } };
      });
      if (created) return created;
    }
    return transaction(db, async sql => {
      const row = (await sql.query(`select tenant, payload_sha256, snapshot, status, leased_until > now() as leased,
          internal_accepted_at is not null as internal, thread_accepted_at is not null as thread
        from help_requests where id = $1 for update`, [id])).rows[0];
      // Another tenant's id looks like a changed request: nothing about it is revealed.
      if (!row || row.tenant !== tenant || row.payload_sha256 !== payload) return { status: "payload_mismatch" as const };
      if (row.status === "delivered") return { status: "delivered" as const };
      if (row.internal && row.thread) {
        await sql.query("update help_requests set status = 'delivered', snapshot = null, lease = null, updated_at = $2 where id = $1", [id, this.now()]);
        return { status: "delivered" as const };
      }
      if (row.status === "pending" && row.leased) return { status: "in_progress" as const };
      const lease = randomUUID();
      await sql.query("update help_requests set status = 'pending', lease = $2, leased_until = now() + make_interval(secs => $3), updated_at = $4 where id = $1",
        [id, lease, LEASE_SECONDS, this.now()]);
      return { status: "accepted" as const, lease, snapshot: row.snapshot as HelpSnapshot, sent: { internal: row.internal, thread: row.thread } };
    });
  }

  /** Record that the provider accepted one email, whoever holds the lease now: a retry must never send it again. */
  private async accepted(id: string, channel: Channel, messageId: string | undefined) {
    const at = `${channel}_accepted_at`, message = `${channel}_message_id`;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.options.db.query(`update help_requests set ${at} = coalesce(${at}, $2), ${message} = coalesce(${message}, $3), updated_at = $2 where id = $1`,
          [id, this.now(), messageId ?? null]);
        return;
      } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 200 * 4 ** attempt));
      }
    }
  }

  /** End this attempt, if it still holds the lease. A delivered request forgets its snapshot. */
  private async finish(id: string, lease: string, status: "delivered" | "failed") {
    await this.options.db.query(`update help_requests set status = $3, lease = null, leased_until = null, updated_at = $4
      ${status === "delivered" ? ", snapshot = null" : ""} where id = $1 and lease = $2`, [id, lease, status, this.now()]);
  }

  /**
   * What support sees about the account, read without loading any agent. A read that fails is named in
   * `unavailable` and shown as unknown, never as an empty answer: that is when support most needs to tell them apart.
   */
  private async collect(caller: HelpCaller, message: HelpMessage, verified: boolean, userAgent?: string): Promise<HelpSnapshot> {
    const { db, accounts } = this.options;
    const tenant = caller.tenant, now = this.now();
    const unavailable: string[] = [];
    const part = async <T>(name: string, read: () => Promise<T>): Promise<T | undefined> => {
      try { return await read(); } catch (error) {
        unavailable.push(name);
        console.error(JSON.stringify({ type: "help_context_failed", part: name, error: errorText(error) }));
        return undefined;
      }
    };
    const [identity, agent, mode, runLimit, autoTopup, agents, keys, customProviders, channels] = await Promise.all([
      part("tenant", async () => (await db.query("select github_id, created_at from tenants where id = $1", [tenant])).rows[0] as { github_id: number | null; created_at: number } | undefined),
      message.agentId ? part("agent", () => this.agent(tenant, message.agentId!, now)) : undefined,
      part("billing", () => accounts.billing.mode(tenant)),
      part("run_limit", async () => { const limit = await accounts.runLimit(tenant); return { blocked: limit === undefined ? undefined : typeof limit === "string" ? limit : limit.message }; }),
      part("auto_topup", async () => {
        const row = (await db.query("select enabled, status from billing_auto_settings where tenant = $1 order by livemode desc limit 1", [tenant])).rows[0];
        return !row?.enabled ? "off" : row.status as string;
      }),
      part("agents", async () => Number((await db.query("select count(*) from agents where tenant = $1 and not revoked and purged_at is null and (expires_at is null or expires_at > $2)", [tenant, now])).rows[0].count)),
      part("keys", async () => (await accounts.keyStatus(tenant)).map(key => `${key.provider} (${key.source})`)),
      part("custom_providers", async () => Number((await db.query("select count(*) from model_providers where tenant = $1", [tenant])).rows[0].count)),
      part("channels", async () => (await db.query("select distinct channel->>'type' as type from channels where tenant = $1 order by 1", [tenant])).rows.map(row => String(row.type))),
    ]);
    const balance = mode === "prepaid" ? await part("balance", async () => (await accounts.billing.account(tenant)).balance) : undefined;
    const defined = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
    return {
      submittedAt: now, ...(userAgent ? { userAgent: userAgent.slice(0, 512) } : {}),
      who: { tenant, ...(caller.login ? { login: caller.login } : {}), ...(identity?.github_id ? { githubId: Number(identity.github_id) } : {}),
        signIn: caller.login ? "github" : "token", ...(identity ? { tenantCreatedAt: Number(identity.created_at) } : {}), replyVerified: verified },
      ...defined("agent", agent),
      account: { ...defined("billing", mode), ...defined("balance", balance), ...defined("runsBlocked", runLimit?.blocked), ...defined("autoTopup", autoTopup),
        ...defined("agents", agents), ...defined("keys", keys), ...defined("customProviders", customProviders), ...defined("channels", channels) },
      runtime: { host: new URL(this.options.origin).host, ...(this.options.release ? { release: this.options.release } : {}), node: hostname(),
        ...(this.options.logGroup ? { logGroup: this.options.logGroup } : {}) },
      ...(unavailable.length ? { unavailable: unavailable.sort() } : {}),
    };
  }

  /** One of the tenant's live agents by ID or key. Missing, deleted and other tenants' agents all read as not found. */
  private async agent(tenant: string, idOrKey: string, now: number): Promise<HelpSnapshot["agent"]> {
    const byId = /^client_[a-f0-9]{40}$/.test(idOrKey);
    const { rows: [row] } = await this.options.db.query(`select id, header->>'key' as key, name, type, model,
        header->'definition'->>'id' as definition_id, header->'definition'->>'revision' as definition_revision,
        pending_runs, resume_failures, resume_after
      from agents where tenant = $1 and ${byId ? "id = $2" : "header->>'key' = $2"}
        and not revoked and purged_at is null and (expires_at is null or expires_at > $3) limit 1`, [tenant, idOrKey, now]);
    if (!row) return { found: false };
    return { found: true, id: row.id, ...(row.key ? { key: row.key } : {}), name: row.name, type: row.type, model: row.model,
      ...(row.definition_id ? { definition: { id: row.definition_id, revision: Number(row.definition_revision) } } : {}),
      pendingRuns: !!row.pending_runs, resumeFailures: Number(row.resume_failures ?? 0), ...(row.resume_after ? { resumeAfter: Number(row.resume_after) } : {}) };
  }
}
