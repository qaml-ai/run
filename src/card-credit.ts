import { transaction, type Db } from "./db.ts";
import type { Billing } from "./billing.ts";
import { stripeId } from "./billing-payments.ts";
import { HttpError } from "./http.ts";
import type { Stripe } from "./stripe.ts";

/** Marks the setup-mode Checkout sessions this runtime creates for card checks. */
export const CARD_CHECK = "agent-runtime-card-check";
export type CardCheckOutcome = { status: "granted" | "not_granted" | "pending"; amount: number };

/**
 * Starting credit unlocked by verifying a card, with no charge: a Stripe Checkout session in
 * setup mode saves a card to the tenant's customer, and once its SetupIntent succeeds the tenant
 * gets the starting grant. It is the one way to starting credit for tenants that did not get it
 * at signup: Google sign-ins always, and GitHub accounts refused or never considered. Each card
 * (its Stripe fingerprint) unlocks credit once across all tenants, and each tenant once. A
 * completed check is settled once per SetupIntent (`card_checks`), whether the webhook or the
 * console's confirmation gets there first, and the grant's ledger key names the card.
 */
export class CardCredit {
  private readonly billing: Billing;
  private readonly db: Db;
  private readonly stripe: Stripe;
  private readonly page: string;
  constructor(billing: Billing, stripe: Stripe, publicUrl?: string) {
    this.billing = billing; this.db = billing.db; this.stripe = stripe;
    this.page = `${publicUrl ?? ""}/console/billing`;
  }

  get amount() { return this.billing.pricing.startingGrant; }

  /** Whether `tenant`, a tenant made by sign-in and billed from credit, may still unlock starting credit. */
  async available(tenant: string, sql: Pick<Db, "query"> = this.db) {
    if (!(this.amount > 0) || this.billing.tenants.has(tenant)) return false;
    const { rows: [row] } = await sql.query(`select t.billing,
        exists (select 1 from credit_ledger l where l.tenant = t.id and l.kind = 'grant' and l.amount > 0 and l.idempotency_key like 'grant:github:%') as github_grant,
        exists (select 1 from card_checks c where c.tenant = t.id and c.granted) as card_grant
      from tenants t where t.id = $1`, [tenant]);
    return row?.billing === "prepaid" && !row.github_grant && !row.card_grant;
  }

  /** A Stripe Checkout session in setup mode, to verify a card; nothing is charged. */
  async start(tenant: string) {
    if (!await this.available(tenant)) throw new HttpError(409, "Starting credit is not available for this account");
    const customer = await this.billing.payments!.customer(tenant);
    const metadata = { purpose: CARD_CHECK, tenant };
    const session = await this.stripe.post("/v1/checkout/sessions", {
      mode: "setup", customer, payment_method_types: ["card"], metadata, setup_intent_data: { metadata },
      success_url: `${this.page}?card_check={CHECKOUT_SESSION_ID}`, cancel_url: `${this.page}?card_check=cancelled`,
    });
    if (typeof session.id !== "string" || !session.id.startsWith("cs_") || typeof session.url !== "string" || !session.url.startsWith("https://") || session.livemode !== this.stripe.live) {
      throw new HttpError(502, "Unexpected Stripe Checkout session");
    }
    return { url: session.url as string };
  }

  /** Settle the console's return from Checkout: `session` must be this tenant's card check. */
  async confirm(tenant: string, session: string): Promise<CardCheckOutcome> {
    if (!/^cs_[A-Za-z0-9_]+$/.test(session)) throw new HttpError(400, "Expected a Checkout session id");
    const object = await this.stripe.get(`/v1/checkout/sessions/${encodeURIComponent(session)}`);
    if (object.metadata?.purpose !== CARD_CHECK || object.metadata?.tenant !== tenant) throw new HttpError(404, "Unknown card check");
    return this.settle(object);
  }

  /** Grant starting credit for a completed setup-mode session (a webhook's, or one fetched by `confirm`), once per SetupIntent. */
  async settle(session: any): Promise<CardCheckOutcome> {
    const tenant = session.metadata?.tenant;
    if (session.mode !== "setup" || session.metadata?.purpose !== CARD_CHECK || typeof tenant !== "string" || session.livemode !== this.stripe.live) {
      throw new HttpError(400, "Not a card check");
    }
    const intentId = stripeId(session.setup_intent);
    if (session.status !== "complete" || !intentId) return { status: "pending", amount: 0 };
    const known = await this.outcome(intentId);
    if (known) return known;
    const customer = await this.billing.payments!.customer(tenant, false);
    if (!customer || stripeId(session.customer) !== customer) throw new HttpError(400, "Card check does not match the tenant's billing customer");
    const intent = await this.stripe.get(`/v1/setup_intents/${encodeURIComponent(intentId)}`, { expand: ["payment_method"] });
    if (intent.id !== intentId || intent.livemode !== this.stripe.live || stripeId(intent.customer) !== customer) throw new HttpError(400, "Card check does not match its SetupIntent");
    if (intent.status !== "succeeded") return { status: "pending", amount: 0 };
    const card = intent.payment_method?.type === "card" ? intent.payment_method.card : undefined;
    if (typeof card?.fingerprint !== "string" || !card.fingerprint) throw new HttpError(400, "The card check has no card");
    const posted = await transaction(this.db, async sql => {
      // The tenant's row, then the card: every settlement locks in this order.
      if (!(await sql.query("select 1 from tenants where id = $1 for update", [tenant])).rowCount) throw new HttpError(404, "Unknown tenant");
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`card-credit:${this.stripe.live}:${card.fingerprint}`]);
      if ((await sql.query("select 1 from card_checks where setup_intent = $1", [intentId])).rowCount) return false;
      const used = (await sql.query("select 1 from card_checks where livemode = $1 and fingerprint = $2 and granted", [this.stripe.live, card.fingerprint])).rowCount;
      // Prepaid cards are refused: they are too easy to have many of.
      const eligible = !used && card.funding !== "prepaid" && await this.available(tenant, sql);
      const [entry] = eligible ? await this.billing.post([{
        tenant, kind: "grant", amount: this.amount, key: `grant:card:${this.stripe.live ? "live" : "test"}:${card.fingerprint}`, metadata: { reason: "Starting credit" },
      }], sql) : [];
      await sql.query("insert into card_checks (setup_intent, tenant, livemode, fingerprint, granted, grant_ledger_id, checked_at) values ($1, $2, $3, $4, $5, $6, $7)",
        [intentId, tenant, this.stripe.live, card.fingerprint, !!entry, entry?.id ?? null, Date.now()]);
      return !!entry;
    });
    this.billing.invalidate([tenant]);
    if (posted) console.log(JSON.stringify({ type: "card_check_granted", tenant, amount: this.amount }));
    return (await this.outcome(intentId))!;
  }

  private async outcome(setupIntent: string): Promise<CardCheckOutcome | undefined> {
    const row = (await this.db.query("select c.granted, l.amount from card_checks c left join credit_ledger l on l.id = c.grant_ledger_id where c.setup_intent = $1", [setupIntent])).rows[0];
    return row && (row.granted ? { status: "granted", amount: Number(row.amount) } : { status: "not_granted", amount: 0 });
  }
}
