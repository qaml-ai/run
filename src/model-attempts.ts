import { recordUsageDetails, resolveUsageAttribution } from "../shared/usage-details.ts";
import { applyWorkspaceUsage } from "./workspaces.ts";
import { createHash } from "node:crypto";
import { Accounts, applyUsageRows, lockBalances, type Totals } from "./accounts.ts";
import { postLedger } from "./billing.ts";
import { databaseUnavailable, databaseRetryable, transaction, type Db } from "./db.ts";
import { isSubscriptionProvider, platformUsage, usageMissing } from "./platform-pricing.ts";
import { enqueueEvents } from "./webhooks.ts";
import { clock, network } from "./node-context.ts";
import type { AttemptAck, ModelAttemptEvent, Superseded } from "./model-attempt.ts";
import { creditRefused } from "./limit-hits.ts";
import { lockEndUser, settleUsage, utcDay, type EndUserCredits } from "./end-user-credits.ts";
import { costAt, unpricedCost } from "./platform-pricing.ts";
import { usageCost } from "./webhooks.ts";

const zero: Totals = { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, platformResponses: 0, platformCost: 0 };
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Past the runtime turn limit and its two overrun grace periods, a lost host cannot still be streaming. */
export const ATTEMPT_STALE_MS = (Number(process.env.AGENT_MAX_RUN_SECONDS) || 7_200) * 1_000 + 120_000;

/** Durable provider attempts. Retried delivery and concurrent reconciliation change each charge only by its delta. */
export class ModelAttempts {
  private checking?: Promise<void>;
  private stopping = new AbortController();
  readonly db: Db;
  readonly accounts: Accounts;
  readonly fetcher: typeof fetch;
  readonly retryMs: number;
  readonly scopedKey?: (tenant: string, scope: string) => Promise<string | { baseUrl: string } | undefined>;
  readonly endUsers?: EndUserCredits;
  constructor(db: Db, accounts: Accounts, fetcher: typeof fetch = network().fetch, retryMs = 0, scopedKey?: (tenant: string, scope: string) => Promise<string | { baseUrl: string } | undefined>, endUsers?: EndUserCredits) {
    this.db = db; this.accounts = accounts; this.fetcher = fetcher; this.retryMs = retryMs; this.scopedKey = scopedKey; this.endUsers = endUsers;
  }

  async event(tenant: string, agent: string, platform: boolean, catalogPriced: boolean, event: ModelAttemptEvent): Promise<boolean | AttemptAck> {
    const deadline = Date.now() + this.retryMs;
    for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
      try { return await this.persistEvent(tenant, agent, platform, catalogPriced, event); }
      catch (error) {
        if ((!databaseUnavailable(error) && !databaseRetryable(error)) || Date.now() + delay > deadline) throw error;
        // Retry the accounting delivery with the same ID, never the provider request.
        await clock().sleep(delay);
      }
    }
  }

  private async persistEvent(tenant: string, agent: string, platform: boolean, catalogPriced: boolean, event: ModelAttemptEvent): Promise<boolean | AttemptAck> {
    if (!uuid.test(event.id)) throw new Error("Invalid model attempt id");
    if (event.type === "begin") {
      if (!/^[a-f0-9]{64}$/.test(event.keyHash)) throw new Error("Invalid model key fingerprint");
      const prepaid = await this.accounts.billing.mode(tenant) === "prepaid";
      const subscription = isSubscriptionProvider(event.provider);
      const metered = event.endUser && !subscription && await this.endUsers?.enabled(tenant) ? event.endUser : undefined;
      const tenantRefused = prepaid && platform && !subscription && !/:free$/.test(event.model)
        && await this.accounts.billing.spendable(tenant, this.db) <= 0;
      const refused = !tenantRefused && metered ? await this.endUsers!.refusal(tenant, metered.id, metered.bucket) : undefined;
      if (tenantRefused || refused) {
        // A delivery retry can follow a committed begin after another call spent the balance.
        const existing = (await this.db.query("select tenant,agent,provider,model from model_attempts where id=$1", [event.id])).rows[0];
        if (existing) {
          if (existing.tenant !== tenant || existing.agent !== agent || existing.provider !== event.provider || existing.model !== event.model) throw new Error("Model attempt identity mismatch");
          return true;
        }
        if (refused) creditRefused(tenant, refused, "model_call");
        return { tracked: false, refused: refused ?? { message: "This account is out of credit or has reached its free hourly allowance", reason: "balance" } };
      }
      // Keep the input estimate for calls with evidence of usage but no final token counts.
      const inputTokens = Number(event.estimate?.inputTokens);
      const usageAttribution = await resolveUsageAttribution(this.db, { tenant, agent, timestamp: event.at, requestId: event.context?.requestId });
      const inserted = await this.db.query(`insert into model_attempts (id,tenant,agent,provider,model,kind,platform,catalog_priced,prepaid,key_hash,context,started_at,updated_at,next_check_at,end_user,end_user_bucket,estimated_input_tokens)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15,$16) on conflict (id) do nothing returning tenant,agent,provider,model`,
        [event.id, tenant, agent, event.provider, event.model, event.kind, platform, catalogPriced, prepaid, event.keyHash, JSON.stringify({ ...event.context, bucket: event.context?.bucket ?? event.endUser?.bucket ?? null, usageAttribution, ...(event.reconciliationEligible === undefined ? {} : { reconciliationEligible: event.reconciliationEligible }), ...(event.reconciliationDisabled || event.keyHash === hash("") ? { reconciliationDisabled: event.reconciliationDisabled ?? "Empty provider credential has no reconciliation; reported usage is final" } : {}) }), event.at, Date.now() + 300_000,
          metered?.id ?? null, metered?.bucket ?? null, Number.isFinite(inputTokens) && inputTokens > 0 ? Math.min(Math.round(inputTokens), 2_000_000_000) : null]);
      // New attempts already returned their identity. A replay still reads the
      // committed row after ON CONFLICT waited for its concurrent inserter.
      const row = inserted.rows[0] ?? (await this.db.query("select tenant,agent,provider,model from model_attempts where id=$1", [event.id])).rows[0];
      if (row.tenant !== tenant || row.agent !== agent || row.provider !== event.provider || row.model !== event.model) throw new Error("Model attempt identity mismatch");
      return true;
    }
    if (event.type === "progress") {
      await this.db.query("update model_attempts set updated_at=$4 where id=$1 and tenant=$2 and agent=$3 and state<>'settled'", [event.id, tenant, agent, Date.now()]);
      return { tracked: true };
    }
    if (event.type === "generation") {
      if (!/^gen-[a-zA-Z0-9-]{1,200}$/.test(event.generation)) return true;
      const result = await this.db.query(`update model_attempts set generation_id=$4, updated_at=$5,next_check_at=least(next_check_at,$5::bigint+60000) where id=$1 and tenant=$2 and agent=$3 and (generation_id is null or generation_id=$4) returning id`, [event.id, tenant, agent, event.generation, Date.now()]);
      if (!result.rowCount) throw new Error("Model attempt generation mismatch");
      return true;
    }
    await this.settle(event.id, tenant, agent, event.usage, event.chars, event.completed, false, false, event.superseded);
    return true;
  }

  /**
   * `superseded`: the call's response was replaced by another call's (model-attempt.ts `finish`). Its usage is kept on
   * the attempt and said in its usage.recorded event (`superseded`), for the books, but it is not the tenant's to pay:
   * no charge, no end-user charge, nothing in the tenant's usage totals.
   */
  async settle(id: string, tenant: string, agent: string, usage: Record<string, any>, chars: number, completed: boolean, reconciled: boolean, staleOnly = false, superseded?: Superseded) {
    await transaction(this.db, async sql => {
      const row = (await sql.query("select * from model_attempts where id=$1 and tenant=$2 and agent=$3 for update", [id, tenant, agent])).rows[0];
      if (!row) throw new Error("Unknown model attempt");
      if (staleOnly && Number(row.updated_at) >= Date.now() - ATTEMPT_STALE_MS) return;
      // Keep the end-user and tenant balance lock order used by turn settlement.
      const lockedEndUser = row.end_user ? { sql, user: await lockEndUser(sql, tenant, row.end_user) } : undefined;
      // Lock the tenant balance before the usage rows and ledger, in the same order as turn receipts and usage flushes.
      if (row.prepaid) await lockBalances(sql, [tenant]);
      // A provider-reconciled or completed record is final. Delayed host deliveries cannot overwrite it.
      if (row.state === "settled" || (!reconciled && !completed && row.totals)) return;
      if (superseded && row.context?.superseded !== superseded) {
        await sql.query("update model_attempts set context = coalesce(context, '{}'::jsonb) || $2::jsonb where id=$1", [id, JSON.stringify({ superseded })]);
        row.context = { ...row.context, superseded };
      }
      // The service tier the call asked for and the one that served it (model-attempt-stream.ts `servedTier`), kept with the attempt.
      const tier = { ...(typeof usage.requestedServiceTier === "string" ? { requestedServiceTier: usage.requestedServiceTier } : {}), ...(typeof usage.serviceTier === "string" ? { serviceTier: usage.serviceTier } : {}) };
      // Written with the attempt's own update below, never as a query of its own: settle is every model call's path.
      const tierContext = Object.keys(tier).length && (row.context?.serviceTier !== tier.serviceTier || row.context?.requestedServiceTier !== tier.requestedServiceTier) ? JSON.stringify(tier) : null;
      if (tierContext) row.context = { ...row.context, ...tier };
      const replaced: Superseded | undefined = row.context?.superseded;
      const disabled = row.context?.reconciliationDisabled || (row.key_hash === hash("") ? "Empty provider credential has no reconciliation; reported usage is final" : undefined);
      const evidence = chars > 0 || [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.providerCost].some(value => typeof value === "number" && value > 0);
      if (!reconciled && !evidence) {
        // Unknown is not a zero-cost final result. Unreconcilable failures have nothing to bill.
        await sql.query("update model_attempts set updated_at=$2, context = case when $3::jsonb is null then context else coalesce(context, '{}'::jsonb) || $3::jsonb end where id=$1", [id, Date.now(), tierContext]);
        if (disabled) await sql.query("update model_attempts set state='settled',last_error=null where id=$1", [id]);
        return;
      }
      // A call that reported nothing to bill it by (its usage never came: a stream that ended between its finish and its
      // usage), or that was cut short, is billed an estimate: the input the host estimated at its begin, and what it
      // streamed at two characters a token. It stays `estimated` where a provider's record may correct it (OpenRouter's);
      // on a provider with no such record, the estimate is final.
      const missing = !reconciled && usageMissing(usage) && typeof usage.providerCost !== "number";
      const inputTokens = Number(usage.estimatedInputTokens ?? row.estimated_input_tokens ?? 0) || 0;
      const estimate = !reconciled && (missing || !completed) ? { chars, inputTokens, completed } : undefined;
      const pricing = row.platform && row.catalog_priced && !(reconciled && usage.providerCost === 0)
        ? platformUsage(usage, row.provider, row.model, estimate) : { usage, estimated: false };
      const reconcilable = row.provider === "openrouter" && !disabled;
      const final = reconciled || !!disabled || (completed && (missing ? !reconcilable : !pricing.estimated || typeof usage.providerCost === "number"));
      const quote = this.accounts.quoteModelUsage(tenant, agent, { provider: row.provider, model: row.model, kind: row.kind === "compaction" ? "compaction" : undefined, platform: row.platform, timestamp: Number(row.started_at), ...row.context, usage: pricing.usage });
      const previous = row.totals ?? zero;
      const delta = Object.fromEntries(Object.keys(zero).map(key => [key, quote.totals[key as keyof Totals] - (previous[key] ?? 0)])) as Totals;
      const amount = row.prepaid && !replaced ? quote.amount : 0;
      const adjustment = amount - Number(row.charge);
      // What the call cost its end user: raw cost as the tenant pays for it; an estimated call on a key priced as
      // reported (the tenant's own, an unbilled tenant's) at the estimate of what it streamed, as a platform call would be.
      const billableEndUser = row.end_user && !isSubscriptionProvider(row.provider) && !replaced;
      const endUserUsage = !billableEndUser || !estimate || (row.platform && row.catalog_priced) ? pricing.usage
        : platformUsage(usage, row.provider, row.model, estimate).usage;
      // On the platform's key it is what the tenant is charged for the call (the provider's price and the cost of funding
      // it), so a markup is over the tenant's real cost, not under it.
      let endUserRaw = !billableEndUser ? 0 : row.platform && endUserUsage === pricing.usage && quote.amount > 0 ? quote.amount : Math.round(usageCost(endUserUsage).usd * 1_000_000);
      // A call on a model with no price (and no cost the provider reported) is not free to its end user: it costs what
      // the catalog says for the model, else a mid-range price (`unpricedCost`), and is said, for the tenant to price it.
      if (billableEndUser && endUserRaw === 0 && typeof endUserUsage.providerCost !== "number") {
        const unpriced = unpricedCost(row.provider, row.model);
        const raw = unpriced ? Math.round(costAt(unpriced, endUserUsage) * 1_000_000) : 0;
        if (raw > 0) {
          endUserRaw = raw;
          console.error(JSON.stringify({ type: "end_user_unpriced_model", tenant, agent, attempt: id, provider: row.provider, model: row.model, raw }));
        }
      }
      if (missing && !row.totals) {
        console.log(JSON.stringify({ type: "model_usage_missing", tenant, agent, attempt: id, kind: row.kind, provider: row.provider, model: row.model, host: usage.providerHost ?? null,
          completed, generation: !!row.generation_id, inputTokens, chars, platform: row.platform, billed: row.prepaid ? quote.amount : 0, ...(row.end_user ? { endUserRaw } : {}) }));
      }
      if (row.totals && adjustment === 0 && Object.values(delta).every(value => value === 0)
        && row.state === (final ? "settled" : "estimated") && endUserRaw === Number(row.end_user_raw)) return;
      const revision = row.revision + 1;
      if (row.end_user && endUserRaw !== Number(row.end_user_raw)) {
        const posted = await settleUsage(sql, {
          tenant, endUser: row.end_user, bucket: row.end_user_bucket, day: utcDay(Number(row.started_at)), raw: endUserRaw, key: `attempt:${id}:${revision}`,
          previous: { raw: Number(row.end_user_raw), allowance: Number(row.end_user_allowance), paid: Number(row.end_user_paid), writtenOff: Number(row.end_user_written_off ?? 0) },
          metadata: { call: row.kind === "compaction" ? "compaction" : "response", attempt: id, provider: row.provider, model: row.model, agent, ...(row.context?.requestId ? { requestId: row.context.requestId } : {}), ...(final && !estimate ? {} : { estimated: true }) },
        }, Date.now(), lockedEndUser);
        await sql.query("update model_attempts set end_user_raw=$2, end_user_allowance=$3, end_user_paid=$4, end_user_written_off=$5 where id=$1", [id, posted.raw, posted.allowance, posted.paid, posted.writtenOff]);
      }
      if (!replaced) {
        await applyUsageRows(sql, [{ tenant, day: quote.day, model: quote.model, ...delta }]);
        await recordUsageDetails(sql, [{ ...(row.context?.usageAttribution ? { attribution: row.context.usageAttribution } : {}), tenant, agent, requestId: row.context?.requestId, endUser: row.context?.identity?.subject ?? row.end_user ?? null, bucket: row.context?.bucket ?? null, timestamp: Number(row.started_at), day: quote.day, model: quote.model, ...delta }]);
        await applyWorkspaceUsage(sql, [{ tenant, agent, timestamp: Number(row.started_at), day: quote.day, model: quote.model, ...delta }]);
      }
      if (adjustment) {
        await postLedger(sql, [{ tenant, kind: "usage", amount: -adjustment, key: `model-attempt:${id}:${revision}`, metadata: { attempt: id, revision, reconciled, estimated: !final || !!estimate, tokens: Math.round((quote.totals.cost-previous.cost)*1e6), funding: adjustment-Math.round((quote.totals.cost-previous.cost)*1e6) } }]);
        // Correct the original minute, not the recovery worker's current hour. Old minutes cannot affect a current cap.
        const minute = Math.floor(Number(row.started_at) / 60_000);
        if (minute >= Math.floor((Date.now() - 3_600_000) / 60_000)) await sql.query(`insert into credit_spend_minutes (tenant,minute,amount) values ($1,$2,greatest(0,$3::bigint))
          on conflict (tenant,minute) do update set amount=greatest(0,credit_spend_minutes.amount+$3::bigint)`, [tenant, minute, adjustment]);
      }
      // A correction has a new event id and the same attempt id; the initial response is never emitted twice.
      for (const event of quote.events) {
        const facts = { attemptId: id, revision, reconciled, correction: !!row.totals, ...(replaced ? { superseded: replaced } : {}),
          input: delta.input, output: delta.output, cacheRead: delta.cacheRead, cacheWrite: delta.cacheWrite,
          cost: { ...(event.data.cost as object), usd: delta.cost } };
        Object.assign(event.data, facts);
        if (event.legacy) Object.assign(event.legacy, facts);
      }
      await enqueueEvents(sql, quote.events);
      await sql.query(`update model_attempts set state=$2,totals=$3,charge=$4,revision=$5,updated_at=$6,next_check_at=$7,last_error=$8,
        context = case when $9::jsonb is null then context else coalesce(context, '{}'::jsonb) || $9::jsonb end where id=$1`,
        [id, final ? "settled" : "estimated", JSON.stringify(quote.totals), amount, revision, Date.now(), Date.now()+60_000, null, tierContext]);
    });
    this.accounts.invalidateModelUsage(tenant);
    // A committed debit must still wake automatic top-up, but its delivery cannot undo settlement.
    void this.accounts.billing.autoTopup?.balanceChanged([tenant]).catch(() => {
      console.error(JSON.stringify({ type: "model_attempt_topup_notify_failed", attempt: id, tenant }));
    });
  }

  /** Shutdown waits for existing work only; it never starts a new round of provider requests. */
  async drain() { this.stopping.abort(); await this.checking; }

  reconcile(): Promise<void> {
    if (this.stopping.signal.aborted) return Promise.resolve();
    if (this.checking) return this.checking;
    return this.checking = this.check().finally(() => { this.checking = undefined; });
  }
  private async check() {
    // The lease is only work distribution. Row locks and revisions enforce exactly-once posting even after expiry.
    const rows = (await this.db.query(`with claimed as (select id from model_attempts where state<>'settled' and next_check_at<=$1 and updated_at<$3 order by (provider='openrouter' and generation_id is not null) desc,next_check_at limit 25 for update skip locked)
      update model_attempts a set next_check_at=$2,checks=checks+1 from claimed where a.id=claimed.id returning a.*`, [Date.now(), Date.now()+300_000, Date.now()-ATTEMPT_STALE_MS])).rows;
    for (const row of rows) {
      if (this.stopping.signal.aborted) break;
      try {
        // Resolve tenant-owned keys too, but never send a key unless its fingerprint matches dispatch.
        const resolved = row.provider === "openrouter" ? await this.accounts.providerKey(row.tenant, "openrouter") : undefined;
        const scoped = row.context?.keyScope && this.scopedKey ? await this.scopedKey(row.tenant, row.context.keyScope) : undefined;
        const disabled = row.context?.reconciliationDisabled || (row.key_hash === hash("") || row.context?.reconciliationEligible === undefined && !row.platform && typeof scoped === "object" || row.provider !== "openrouter"
          ? "Provider credential has no direct reconciliation; reported usage is final" : undefined);
        if (disabled) {
          // 2026-10-23: old gateway attempts have only an empty fingerprint or a scoped address. Keep any posted estimate.
          await this.db.query("update model_attempts set context=context || $2::jsonb where id=$1 and updated_at<$3", [row.id, JSON.stringify({ reconciliationDisabled: disabled }), Date.now()-ATTEMPT_STALE_MS]);
          await this.db.query("update model_attempts set state='settled',last_error=null,updated_at=$2 where id=$1 and updated_at<$3", [row.id, Date.now(), Date.now()-ATTEMPT_STALE_MS]);
          continue;
        }
        if (!row.generation_id && row.state === "pending" && !row.totals) {
          // A stale attempt with neither a generation nor reported usage has nothing to reconcile or bill.
          await this.settle(row.id, row.tenant, row.agent, { providerCost: 0, providerCreditCost: 0 }, 0, true, true, true);
          continue;
        }
        if (!row.generation_id) throw new Error("Awaiting provider evidence; missing OpenRouter generation ID");
        const candidates = [typeof scoped === "string" ? scoped : undefined, resolved?.key, this.accounts.tenants.platformKey("openrouter")];
        const key = candidates.find(value => value && hash(value) === row.key_hash);
        if (!key || hash(key) !== row.key_hash) throw new Error("Original provider credential is unavailable; awaiting reconciliation with its account");
        const response = await this.fetcher(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(row.generation_id)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.any([AbortSignal.timeout(10_000), this.stopping.signal]) });
        if (!response.ok) throw new Error(`Provider lookup HTTP ${response.status}`);
        const { data } = await response.json() as any;
        if (data?.id !== row.generation_id || !Number.isFinite(data.total_cost) || data.total_cost < 0 || !Number.isFinite(data.generation_time)) throw new Error("Provider usage is not final or is missing");
        if (!data.finish_reason && !data.native_finish_reason && data.cancelled !== true) throw new Error("Provider request has no terminal evidence");
        if (data.is_byok && (!Number.isFinite(data.upstream_inference_cost) || data.upstream_inference_cost < 0)) throw new Error("Provider upstream cost is missing");
        const cost = data.total_cost + (data.is_byok ? data.upstream_inference_cost : 0);
        if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid provider cost");
        const prompt = Number(data.native_tokens_prompt) || 0, cached = Number(data.native_tokens_cached) || 0;
        await this.settle(row.id, row.tenant, row.agent, { input: Math.max(0,prompt-cached), output: Number(data.native_tokens_completion)||0, cacheRead: cached, cacheWrite: 0, providerCost: cost, providerCreditCost: data.total_cost }, 0, true, true, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Provider reconciliation failed";
        await this.db.query("update model_attempts set last_error=$2,next_check_at=$3 where id=$1 and state<>'settled' and updated_at<$4", [row.id, message, Date.now()+(row.provider !== "openrouter" || !row.generation_id ? 86_400_000 : Math.min(86_400_000,60_000*2**Math.min(row.checks,10))), Date.now()-ATTEMPT_STALE_MS]);
        console.error(JSON.stringify({ type: "model_attempt_unresolved", attempt: row.id, tenant: row.tenant, reason: message }));
      }
    }
  }
}
