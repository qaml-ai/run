/**
 * What prepaid tenants pay, and the limits on free credit. Every amount is integer
 * micro-USD (1 USD = 1,000,000), as in the credit ledger, except the dimensionless
 * provider credit multiplier. Model usage on platform
 * keys passes through the provider's reported cost (catalog estimate if absent),
 * plus the cost of funding provider credits, with no runtime markup.
 */
export interface Pricing {
  /** Per hour an agent spends in a turn (model calls and tool execution), metered continuously. */
  agentHour: number;
  /** Per GB (10^9 bytes) stored for a month, charged daily pro rata. */
  storageGbMonth: number;
  /** Dollars paid per dollar of OpenRouter credits; match the platform account's actual funding costs. */
  openrouterCreditMultiplier: number;
  /** Per web_search on the platform's key for the provider that answered: each provider's list price by default. */
  webSearch: { exa: number; brave: number; parallel: number };
  /** Per page web_fetch has Firecrawl render on the platform's key (one Firecrawl credit at its Standard plan's price by default). */
  webRender: number;
  /** Fee on a credit purchase, in basis points (550 = 5.5%). */
  purchaseFeeBps: number;
  minPurchase: number;
  maxPurchase: number;
  /** Credit every new self-serve tenant starts with, once. */
  startingGrant: number;
  /** Limits on a tenant that has never bought credit. */
  free: {
    /** Agents it may have hosted at once on each node. */
    maxAgents: number;
    /** Credit it may spend on model tokens and agent time in any hour. */
    hourlySpend: number;
  };
}

export const MICROS = 1_000_000;
export const micros = (usd: number) => Math.round(usd * MICROS);

export const DEFAULT_PRICING: Pricing = Object.freeze({
  agentHour: micros(0.01),
  storageGbMonth: micros(0.10),
  openrouterCreditMultiplier: 1.055,
  webSearch: Object.freeze({ exa: micros(0.007), brave: micros(0.005), parallel: micros(0.001) }),
  webRender: micros(0.00083),
  purchaseFeeBps: 550,
  minPurchase: micros(5),
  maxPurchase: micros(1000),
  startingGrant: micros(5),
  free: Object.freeze({ maxAgents: 2, hourlySpend: micros(1) }),
});

/**
 * Rates from the environment, in USD (AGENT_PRICE_AGENT_HOUR_USD, AGENT_PRICE_STORAGE_GB_MONTH_USD,
 * AGENT_PRICE_WEB_SEARCH_<EXA|BRAVE|PARALLEL>_USD (or AGENT_PRICE_WEB_SEARCH_USD for all three), AGENT_PRICE_WEB_RENDER_USD, AGENT_CREDIT_FEE_PERCENT, AGENT_CREDIT_MIN_PURCHASE_USD, AGENT_CREDIT_MAX_PURCHASE_USD,
 * AGENT_CREDIT_GRANT_USD, AGENT_FREE_MAX_AGENTS, AGENT_FREE_HOURLY_SPEND_USD); unset ones keep the defaults.
 * AGENT_OPENROUTER_CREDIT_MULTIPLIER is the actual dollars paid per dollar of provider credit.
 */
export function pricingFromEnvironment(env = process.env): Pricing {
  const usd = (name: string, fallback: number) => {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number of USD`);
    return micros(value);
  };
  const fee = env.AGENT_CREDIT_FEE_PERCENT === undefined ? DEFAULT_PRICING.purchaseFeeBps : Math.round(Number(env.AGENT_CREDIT_FEE_PERCENT) * 100);
  if (!Number.isInteger(fee) || fee < 0 || fee > 10_000) throw new Error("AGENT_CREDIT_FEE_PERCENT must be a percentage between 0 and 100");
  const maxAgents = Number(env.AGENT_FREE_MAX_AGENTS ?? DEFAULT_PRICING.free.maxAgents);
  if (!Number.isInteger(maxAgents) || maxAgents < 1) throw new Error("AGENT_FREE_MAX_AGENTS must be a positive integer");
  const openrouterCreditMultiplier = Number(env.AGENT_OPENROUTER_CREDIT_MULTIPLIER ?? DEFAULT_PRICING.openrouterCreditMultiplier);
  if (!Number.isFinite(openrouterCreditMultiplier) || openrouterCreditMultiplier < 0) throw new Error("AGENT_OPENROUTER_CREDIT_MULTIPLIER must be a non-negative number");
  const pricing: Pricing = {
    agentHour: usd("AGENT_PRICE_AGENT_HOUR_USD", DEFAULT_PRICING.agentHour),
    storageGbMonth: usd("AGENT_PRICE_STORAGE_GB_MONTH_USD", DEFAULT_PRICING.storageGbMonth),
    openrouterCreditMultiplier,
    webSearch: {
      exa: usd("AGENT_PRICE_WEB_SEARCH_EXA_USD", usd("AGENT_PRICE_WEB_SEARCH_USD", DEFAULT_PRICING.webSearch.exa)),
      brave: usd("AGENT_PRICE_WEB_SEARCH_BRAVE_USD", usd("AGENT_PRICE_WEB_SEARCH_USD", DEFAULT_PRICING.webSearch.brave)),
      parallel: usd("AGENT_PRICE_WEB_SEARCH_PARALLEL_USD", usd("AGENT_PRICE_WEB_SEARCH_USD", DEFAULT_PRICING.webSearch.parallel)),
    },
    webRender: usd("AGENT_PRICE_WEB_RENDER_USD", DEFAULT_PRICING.webRender),
    purchaseFeeBps: fee,
    minPurchase: usd("AGENT_CREDIT_MIN_PURCHASE_USD", DEFAULT_PRICING.minPurchase),
    maxPurchase: usd("AGENT_CREDIT_MAX_PURCHASE_USD", DEFAULT_PRICING.maxPurchase),
    startingGrant: usd("AGENT_CREDIT_GRANT_USD", DEFAULT_PRICING.startingGrant),
    free: { maxAgents, hourlySpend: usd("AGENT_FREE_HOURLY_SPEND_USD", DEFAULT_PRICING.free.hourlySpend) },
  };
  if (pricing.minPurchase < micros(0.5) || pricing.maxPurchase < pricing.minPurchase) throw new Error("AGENT_CREDIT_MIN_PURCHASE_USD must be at least 0.50 (Stripe's minimum) and at most AGENT_CREDIT_MAX_PURCHASE_USD");
  return pricing;
}

/** The charge for `ms` of active agent time. */
export const activeCharge = (pricing: Pricing, ms: number) => Math.round(ms * pricing.agentHour / 3_600_000);

/** One day's charge for `bytes` stored, in a month of `days` days. */
export const storageCharge = (pricing: Pricing, bytes: number, days: number) => Math.round(bytes * pricing.storageGbMonth / 1e9 / days);

/** The fee on buying `amount` of credit, rounded to the cent, as Stripe charges whole cents. */
export const purchaseFee = (pricing: Pricing, amount: number) => Math.round(amount * pricing.purchaseFeeBps / 10_000 / 10_000) * 10_000;
