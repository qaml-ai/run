import { applyWorkspaceUsage } from "./workspaces.ts";
import { createHash } from "node:crypto";
import { Accounts, applyUsageRows, type Totals } from "./accounts.ts";
import { postLedger } from "./billing.ts";
import { databaseUnavailable, databaseRetryable, transaction, type Db } from "./db.ts";
import { isSubscriptionProvider, platformUsage, usageMissing } from "./platform-pricing.ts";
import { enqueueEvents } from "./webhooks.ts";
import { clock, network } from "./node-context.ts";
import type { AttemptAck, AttemptEstimate, CreditStop, ModelAttemptEvent, Superseded } from "./model-attempt.ts";
import { CreditHolds } from "./credit-holds.ts";
import { lastCallMin, lockEndUser, settleUsage, unmarked, utcDay, type EndUserCredits } from "./end-user-credits.ts";
import { catalogCost, costAt, UNPRICED_COST, unpricedCost } from "./platform-pricing.ts";
import { usageCost } from "./webhooks.ts";

const zero: Totals = { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, platformResponses: 0, platformCost: 0 };
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A metered call's hold (end-user-credits.ts) is its input and up to this much output, and grows by as much again each
 * time its stream reaches the end of what it holds. To start it needs its input and MIN_OUTPUT_TOKENS of output, less
 * the shortfall a last call may have (`lastCallMin`).
 */
export const HOLD_OUTPUT_TOKENS = 8_192;
/** Past the runtime turn limit and its two overrun grace periods, a lost host cannot still be streaming. */
export const ATTEMPT_STALE_MS = (Number(process.env.AGENT_MAX_RUN_SECONDS) || 7_200) * 1_000 + 120_000;
/**
 * What a call holds of its output to start: about what a reply takes, not the most it may write (a model's whole max
 * output, held by each of a person's calls at once, refused their next call with credit left for it). A longer reply
 * holds more as it streams (`progress`), HOLD_OUTPUT_TOKENS at a time.
 */
export const INITIAL_OUTPUT_TOKENS = 2_048;
export const MIN_OUTPUT_TOKENS = 256;
/** Streamed characters per output token, as an output estimate counts them: fewer than real tokens take, so it runs ahead of cost. */
const CHARS_PER_TOKEN = 2;
/**
 * A hold on a call running on this node, of its end user's credit or its tenant's: its input's estimated cost and its
 * output's per token (raw micro-USD), the most output it asked for, what it holds, and how to hold more.
 */
type Metered = { input: number; perToken: number; maxOutput: number; held: number; more(want: number): Promise<{ raw: number; refused?: CreditStop }>; renew(): Promise<unknown> };
/** How far ahead of the end of its hold a streaming call asks for more, so its stream never waits on the answer. */
const ASK_AHEAD_TOKENS = 2_048;
/**
 * Where a metered call's estimate reaches what it holds (`stopAtChars`), and where it asks for more ahead of that
 * (`checkAtChars`); neither when its output costs nothing. With two holds, the nearer.
 */
const lines = (holds: Metered[]): Pick<AttemptAck, "checkAtChars" | "stopAtChars"> => {
  const each = holds.filter(metered => metered.perToken > 0).map(metered => {
    // A last call may hold less than its input: it still gets a short reply, as any call that starts does.
    const stop = Math.max(Math.min(metered.maxOutput, MIN_OUTPUT_TOKENS) * CHARS_PER_TOKEN, Math.floor((metered.held - metered.input) / metered.perToken * CHARS_PER_TOKEN));
    // A short hold asks halfway through, so a reply that fits it never asks at all.
    return { stopAtChars: stop, checkAtChars: Math.max(0, stop - Math.min(ASK_AHEAD_TOKENS * CHARS_PER_TOKEN, Math.floor(stop / 2))) };
  });
  return each.length ? { stopAtChars: Math.min(...each.map(line => line.stopAtChars)), checkAtChars: Math.min(...each.map(line => line.checkAtChars)) } : {};
};

/** The most output `most` (micro-USD, all that could be held) pays for after the call's input: at least what any call that starts gets. */
const affordable = (metered: Metered, most: number) => metered.perToken > 0 ? Math.max(Math.min(metered.maxOutput, MIN_OUTPUT_TOKENS), Math.floor((most - metered.input) / metered.perToken)) : undefined;

/** A call's estimated cost at `rates`: the long-context tier its input reaches, where the rates have one. */
function callCost(rates: { input: number; output: number; cacheRead?: number; tiers?: { inputTokensAbove: number; input: number; output: number; cacheRead?: number }[] }, estimate: AttemptEstimate | undefined, funding: number) {
  const inputTokens = Math.max(0, estimate?.inputTokens ?? 0), cached = Math.min(inputTokens, Math.max(0, estimate?.cachedTokens ?? 0));
  const tier = rates.tiers?.filter(entry => inputTokens > entry.inputTokensAbove).at(-1) ?? rates;
  // USD per million tokens is micro-USD per token. Its input at the input rate, but for the part the provider likely reads from its cache, at that rate.
  const inputRate = Math.max(0, Number(tier.input) || 0), cachedRate = Math.min(inputRate, Math.max(0, Number(tier.cacheRead ?? inputRate) || 0));
  const perToken = Math.max(0, Number(tier.output) || 0) * funding, input = Math.ceil(((inputTokens - cached) * inputRate + cached * cachedRate) * funding);
  const maxOutput = Math.max(1, estimate?.maxOutputTokens ?? HOLD_OUTPUT_TOKENS);
  return { input, perToken, maxOutput, want: input + Math.ceil(Math.min(maxOutput, INITIAL_OUTPUT_TOKENS) * perToken), min: lastCallMin(input + Math.ceil(Math.min(maxOutput, MIN_OUTPUT_TOKENS) * perToken)) };
}

/** Durable provider attempts. Retried delivery and concurrent reconciliation change each charge only by its delta. */
export class ModelAttempts {
  private checking?: Promise<void>;
  private stopping = new AbortController();
  readonly db: Db;
  readonly accounts: Accounts;
  readonly fetcher: typeof fetch;
  readonly retryMs: number;
  readonly scopedKey?: (tenant: string, scope: string) => Promise<string | { baseUrl: string } | undefined>;
  /** End users' credit: a begin naming its end user holds its estimate, and a settlement posts what it cost them. */
  readonly endUsers?: EndUserCredits;
  /** Calls metered for their end users or tenants, in flight on this node, by attempt id. */
  private readonly metered = new Map<string, Metered[]>();
  private readonly credit: CreditHolds;
  constructor(db: Db, accounts: Accounts, fetcher: typeof fetch = network().fetch, retryMs = 0, scopedKey?: (tenant: string, scope: string) => Promise<string | { baseUrl: string } | undefined>, endUsers?: EndUserCredits) {
    this.db = db; this.accounts = accounts; this.fetcher = fetcher; this.retryMs = retryMs; this.scopedKey = scopedKey; this.endUsers = endUsers;
    this.credit = new CreditHolds(db, accounts.billing);
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
      // Its holds come first: a call their credit refuses is never made, and leaves no attempt.
      const metered = event.endUser && this.endUsers ? await this.hold(tenant, platform, platform && catalogPriced, event) : undefined;
      if (metered && "refused" in metered) return { tracked: false, refused: metered.refused };
      const credit = await this.creditHold(tenant, platform, event);
      if (credit && "refused" in credit) {
        if (metered) await this.endUsers!.release(event.id);
        return { tracked: false, refused: credit.refused };
      }
      const prepaid = await this.accounts.billing.mode(tenant) === "prepaid";
      // Keep the input estimate for calls with evidence of usage but no final token counts.
      const inputTokens = Number(event.estimate?.inputTokens);
      await this.db.query(`insert into model_attempts (id,tenant,agent,provider,model,kind,platform,catalog_priced,prepaid,key_hash,context,started_at,updated_at,next_check_at,end_user,end_user_bucket,estimated_input_tokens)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15,$16) on conflict (id) do nothing`,
        [event.id, tenant, agent, event.provider, event.model, event.kind, platform, catalogPriced, prepaid, event.keyHash, JSON.stringify({ ...event.context, ...(event.reconciliationEligible === undefined ? {} : { reconciliationEligible: event.reconciliationEligible }), ...(event.reconciliationDisabled || event.keyHash === hash("") ? { reconciliationDisabled: event.reconciliationDisabled ?? "Empty provider credential has no reconciliation; reported usage is final" } : {}) }), event.at, Date.now() + 300_000,
          metered ? event.endUser!.id : null, metered ? event.endUser!.bucket : null, Number.isFinite(inputTokens) && inputTokens > 0 ? Math.min(Math.round(inputTokens), 2_000_000_000) : null]);
      const row = (await this.db.query("select tenant,agent,provider,model from model_attempts where id=$1", [event.id])).rows[0];
      if (row.tenant !== tenant || row.agent !== agent || row.provider !== event.provider || row.model !== event.model) throw new Error("Model attempt identity mismatch");
      const holds = [metered, credit].filter(hold => !!hold) as (Metered & { most: number })[];
      if (!holds.length) return true;
      this.metered.set(event.id, holds);
      const most = holds.flatMap(hold => affordable(hold, hold.most) ?? []);
      return { tracked: true, ...lines(holds), ...(most.length ? { maxOutputTokens: Math.min(...most) } : {}) };
    }
    if (event.type === "progress") {
      await this.db.query("update model_attempts set updated_at=$4 where id=$1 and tenant=$2 and agent=$3 and state<>'settled'", [event.id, tenant, agent, Date.now()]);
      return this.progress(event.id, event.chars);
    }
    if (event.type === "generation") {
      if (!/^gen-[a-zA-Z0-9-]{1,200}$/.test(event.generation)) return true;
      const result = await this.db.query(`update model_attempts set generation_id=$4, updated_at=$5,next_check_at=least(next_check_at,$5::bigint+60000) where id=$1 and tenant=$2 and agent=$3 and (generation_id is null or generation_id=$4) returning id`, [event.id, tenant, agent, event.generation, Date.now()]);
      if (!result.rowCount) throw new Error("Model attempt generation mismatch");
      return true;
    }
    try { await this.settle(event.id, tenant, agent, event.usage, event.chars, event.completed, false, false, event.superseded); }
    finally { this.metered.delete(event.id); }
    return true;
  }

  /**
   * Hold a call's estimate for its end user: its input, and up to INITIAL_OUTPUT_TOKENS of its output, at the catalog's
   * rates where the tenant pays the platform for the call (its own key's call: at its model's, as the host has them).
   * Undefined: the tenant does not meter its end users.
   */
  private async hold(tenant: string, platform: boolean, catalog: boolean, event: Extract<ModelAttemptEvent, { type: "begin" }>): Promise<(Metered & { most: number }) | { refused: CreditStop } | undefined> {
    // The connected ChatGPT plan pays for this call, including through a tenant's gateway.
    if (isSubscriptionProvider(event.provider)) return undefined;
    const { endUser, estimate } = event;
    // A model the catalog lacks holds at a mid-range price, never the dearest it may be billed at: a hold that size would
    // refuse everyone on a small allowance. What it cost is what settles (`settle`).
    const listed = catalogCost(event.provider, event.model);
    let rates: { input: number; output: number; cacheRead?: number } = catalog ? listed ?? UNPRICED_COST : estimate?.rates ?? listed ?? UNPRICED_COST;
    // A model with no price is never free to its end user: it holds at the price it settles at.
    const unpriced = !(Number(rates.input) > 0) && !(Number(rates.output) > 0) ? unpricedCost(event.provider, event.model) : undefined;
    if (unpriced) rates = unpriced;
    if (catalog && !listed || unpriced) console.error(JSON.stringify({ type: "end_user_unpriced_model", tenant, attempt: event.id, provider: event.provider, model: event.model, stage: "hold" }));
    // On the platform's OpenRouter key, the tenant also pays for funding its credits (settled as it is charged: `settle`).
    const funding = platform && event.provider === "openrouter" ? this.accounts.billing.pricing.openrouterCreditMultiplier : 1;
    const cost = callCost(rates, estimate, funding);
    const reserved = await this.endUsers!.reserve(tenant, endUser!.id, endUser!.bucket, { id: event.id, want: cost.want, min: cost.min });
    if (!reserved) return undefined;
    if (reserved.refused) return { refused: reserved.refused };
    return {
      input: cost.input, perToken: cost.perToken, maxOutput: cost.maxOutput, held: reserved.hold.raw, most: reserved.most ?? reserved.hold.raw,
      more: async want => { const more = await this.endUsers!.extend(tenant, endUser!.id, endUser!.bucket, event.id, want); return more.hold ? { raw: more.hold.raw } : { raw: 0, refused: more.refused }; },
      renew: () => this.endUsers!.renew(tenant, endUser!.id, event.id),
    };
  }

  /**
   * Hold a call's estimate of its tenant's credit, where the platform's key pays for it and the tenant pays from credit
   * (credit-holds.ts). A model with no price holds at a mid-range one, as for an end user: a router's cost depends on where
   * it sends the call, so its catalog entry says zero, and only a `:free` model is really free. What it cost is what settles.
   */
  private async creditHold(tenant: string, platform: boolean, event: Extract<ModelAttemptEvent, { type: "begin" }>): Promise<(Metered & { most: number }) | { refused: CreditStop } | undefined> {
    if (!platform || !event.estimate || isSubscriptionProvider(event.provider) || await this.accounts.billing.mode(tenant) !== "prepaid") return undefined;
    if (/:free$/.test(event.model)) return undefined;
    const listed = catalogCost(event.provider, event.model);
    const rates = listed && (listed.input > 0 || listed.output > 0) ? listed : UNPRICED_COST;
    const funding = event.provider === "openrouter" ? this.accounts.billing.pricing.openrouterCreditMultiplier : 1;
    const cost = callCost(rates, event.estimate, funding);
    if (!(cost.want > 0)) return undefined;
    const reserved = await this.credit.reserve(tenant, event.id, cost.want, cost.min);
    if (!reserved) return { refused: { message: "This account's credit does not cover this model call", reason: "balance" } };
    return {
      input: cost.input, perToken: cost.perToken, maxOutput: cost.maxOutput, held: reserved.held, most: reserved.most,
      more: async want => {
        const raw = await this.credit.extend(tenant, event.id, want);
        return raw ? { raw } : { raw: 0, refused: { message: "This account's credit ran out during this model call", reason: "balance" } };
      },
      renew: () => this.credit.renew(event.id),
    };
  }

  /**
   * A metered call streamed `chars`, nearing the end of its hold: it holds up to another HOLD_OUTPUT_TOKENS' worth
   * past where it is. Its end user having nothing more, it is refused: the host cuts its stream where its hold ends. One
   * that needs no more yet (a slow reply, reporting as time passes: `RENEW_MS`) keeps its hold from lapsing.
   */
  private async progress(id: string, chars: number): Promise<AttemptAck> {
    const holds = this.metered.get(id);
    if (!holds) return { tracked: true };
    for (const metered of holds) {
      const spent = metered.input + Math.ceil(chars / CHARS_PER_TOKEN * metered.perToken);
      const want = spent + Math.ceil(HOLD_OUTPUT_TOKENS * metered.perToken) - metered.held;
      if (want > 0) {
        const more = await metered.more(want);
        if (more.refused) return { tracked: true, stopAtChars: lines(holds).stopAtChars, refused: more.refused };
        metered.held += more.raw;
      } else await metered.renew();
    }
    return { tracked: true, ...lines(holds) };
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
      // The host's report ends the call: its end user's hold goes, spent or not (an outcome still unknown is posted when
      // it is known, as the tenant's charge is).
      // The end user's row first, as everything that touches their holds locks it (end-user-credits.ts).
      let hold: { allowance: string; paid: string } | undefined;
      if (row.end_user && !reconciled) {
        await lockEndUser(sql, tenant, row.end_user);
        hold = (await sql.query("delete from end_user_holds where id=$1 returning allowance, paid", [id])).rows[0];
      }
      if (!reconciled) await sql.query("delete from credit_holds where id=$1", [id]);
      // A provider-reconciled or completed record is final. Delayed host deliveries cannot overwrite it.
      if (row.state === "settled" || (!reconciled && !completed && row.totals)) return;
      if (superseded && row.context?.superseded !== superseded) {
        await sql.query("update model_attempts set context = coalesce(context, '{}'::jsonb) || $2::jsonb where id=$1", [id, JSON.stringify({ superseded })]);
        row.context = { ...row.context, superseded };
      }
      const replaced: Superseded | undefined = row.context?.superseded;
      const disabled = row.context?.reconciliationDisabled || (row.key_hash === hash("") ? "Empty provider credential has no reconciliation; reported usage is final" : undefined);
      const evidence = chars > 0 || [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.providerCost].some(value => typeof value === "number" && value > 0);
      if (!reconciled && !evidence) {
        // Unknown is not a zero-cost final result. Unreconcilable failures have nothing to bill.
        await sql.query("update model_attempts set updated_at=$2 where id=$1", [id, Date.now()]);
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
      // An estimate is never charged past what the call held (the hold grows as it streams, so this binds only where the
      // estimate counts high); its hold gone, past what it was charged when it ended.
      const capped = !!billableEndUser && !!estimate && typeof usage.providerCost !== "number";
      const settings = capped && hold ? (await sql.query("select markup_bps from end_user_settings where tenant=$1", [tenant])).rows[0] : undefined;
      const held = hold ? Number(hold.allowance) + unmarked(Number(hold.paid), Number(settings?.markup_bps ?? 0)) : row.totals ? Number(row.end_user_raw) : undefined;
      if (capped && held !== undefined) endUserRaw = Math.min(endUserRaw, held);
      if (missing && !row.totals) {
        console.log(JSON.stringify({ type: "model_usage_missing", tenant, agent, attempt: id, kind: row.kind, provider: row.provider, model: row.model, host: usage.providerHost ?? null,
          completed, generation: !!row.generation_id, inputTokens, chars, platform: row.platform, billed: row.prepaid ? quote.amount : 0, ...(row.end_user ? { endUserRaw, held: held ?? null } : {}) }));
      }
      if (row.totals && adjustment === 0 && Object.values(delta).every(value => value === 0)
        && row.state === (final ? "settled" : "estimated") && endUserRaw === Number(row.end_user_raw)) return;
      const revision = row.revision + 1;
      if (row.end_user && endUserRaw !== Number(row.end_user_raw)) {
        const posted = await settleUsage(sql, {
          tenant, endUser: row.end_user, bucket: row.end_user_bucket, day: utcDay(Number(row.started_at)), raw: endUserRaw, key: `attempt:${id}:${revision}`,
          previous: { raw: Number(row.end_user_raw), allowance: Number(row.end_user_allowance), paid: Number(row.end_user_paid), writtenOff: Number(row.end_user_written_off ?? 0) },
          metadata: { call: row.kind === "compaction" ? "compaction" : "response", attempt: id, provider: row.provider, model: row.model, agent, ...(row.context?.requestId ? { requestId: row.context.requestId } : {}), ...(final && !estimate ? {} : { estimated: true }) },
        });
        await sql.query("update model_attempts set end_user_raw=$2, end_user_allowance=$3, end_user_paid=$4, end_user_written_off=$5 where id=$1", [id, posted.raw, posted.allowance, posted.paid, posted.writtenOff]);
      }
      if (!replaced) {
        await applyUsageRows(sql, [{ tenant, day: quote.day, model: quote.model, ...delta }]);
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
      await sql.query(`update model_attempts set state=$2,totals=$3,charge=$4,revision=$5,updated_at=$6,next_check_at=$7,last_error=$8 where id=$1`,
        [id, final ? "settled" : "estimated", JSON.stringify(quote.totals), amount, revision, Date.now(), Date.now()+60_000, null]);
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
