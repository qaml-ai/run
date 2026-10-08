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
  /** Per minute of audio transcribed on the platform's key (OpenAI's gpt-transcribe), billed per second as the provider bills it. */
  transcription: number;
  /** Fee on a credit purchase, in basis points (550 = 5.5%). */
  purchaseFeeBps: number;
  minPurchase: number;
  maxPurchase: number;
  /** Credit every new self-serve tenant starts with, once. */
  startingGrant: number;
  /** Bytes a tenant that has bought credit may store in all (as the storage charge counts them), unless set for it. */
  maxStorageBytes: number;
  /** Limits on a tenant that has never bought credit. */
  free: {
    /** Credit it may spend on model tokens and agent time in any hour. */
    hourlySpend: number;
    /** Bytes it may store in all. */
    maxStorageBytes: number;
  };
  /** Usage tiers by what a tenant has paid for credit, lowest first; the first starts at 0. */
  tiers: UsageTier[];
}

/** A usage tier: a tenant that has paid at least `paid` in total (net of refunds) may have `busyAgents` agents busy at once. */
export interface UsageTier { name: string; paid: number; busyAgents: number }

export const MICROS = 1_000_000;
export const micros = (usd: number) => Math.round(usd * MICROS);

export const DEFAULT_PRICING: Pricing = Object.freeze({
  agentHour: micros(0.01),
  storageGbMonth: micros(0.10),
  openrouterCreditMultiplier: 1.055,
  webSearch: Object.freeze({ exa: micros(0.007), brave: micros(0.005), parallel: micros(0.001) }),
  webRender: micros(0.00083),
  // OpenAI's list price for gpt-transcribe.
  transcription: micros(0.0045),
  purchaseFeeBps: 550,
  minPurchase: micros(5),
  maxPurchase: micros(1000),
  startingGrant: micros(5),
  maxStorageBytes: 100e9,
  free: Object.freeze({ hourlySpend: micros(1), maxStorageBytes: 1e9 }),
  tiers: Object.freeze([
    { name: "Free", paid: 0, busyAgents: 20 },
    { name: "Tier 1", paid: micros(5), busyAgents: 50 },
    { name: "Tier 2", paid: micros(50), busyAgents: 100 },
    { name: "Tier 3", paid: micros(250), busyAgents: 250 },
    { name: "Tier 4", paid: micros(1000), busyAgents: 1000 },
  ].map(tier => Object.freeze(tier))) as UsageTier[],
});

/**
 * Rates from the environment, in USD (AGENT_PRICE_AGENT_HOUR_USD, AGENT_PRICE_STORAGE_GB_MONTH_USD,
 * AGENT_PRICE_WEB_SEARCH_<EXA|BRAVE|PARALLEL>_USD (or AGENT_PRICE_WEB_SEARCH_USD for all three), AGENT_PRICE_WEB_RENDER_USD, AGENT_PRICE_TRANSCRIPTION_USD (per minute of audio), AGENT_CREDIT_FEE_PERCENT, AGENT_CREDIT_MIN_PURCHASE_USD, AGENT_CREDIT_MAX_PURCHASE_USD,
 * AGENT_CREDIT_GRANT_USD, AGENT_FREE_HOURLY_SPEND_USD, AGENT_USAGE_TIERS) and storage limits in GB (AGENT_MAX_STORAGE_GB,
 * AGENT_FREE_MAX_STORAGE_GB); unset ones keep the defaults.
 * AGENT_OPENROUTER_CREDIT_MULTIPLIER is the actual dollars paid per dollar of provider credit.
 */
export function pricingFromEnvironment(env = process.env): Pricing {
  const usd = (name: string, fallback: number) => {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    // Within integer micro-USD that the ledger can hold exactly (postLedger refuses any other amount).
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(micros(value))) throw new Error(`${name} must be a non-negative number of USD`);
    return micros(value);
  };
  const fee = env.AGENT_CREDIT_FEE_PERCENT === undefined ? DEFAULT_PRICING.purchaseFeeBps : Math.round(Number(env.AGENT_CREDIT_FEE_PERCENT) * 100);
  if (!Number.isInteger(fee) || fee < 0 || fee > 10_000) throw new Error("AGENT_CREDIT_FEE_PERCENT must be a percentage between 0 and 100");
  if (env.AGENT_FREE_MAX_AGENTS !== undefined) throw new Error("AGENT_FREE_MAX_AGENTS is replaced by AGENT_USAGE_TIERS: set the first tier's busyAgents");
  const gigabytes = (name: string, fallback: number) => {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number of GB`);
    return Math.round(value * 1e9);
  };
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
    transcription: usd("AGENT_PRICE_TRANSCRIPTION_USD", DEFAULT_PRICING.transcription),
    purchaseFeeBps: fee,
    minPurchase: usd("AGENT_CREDIT_MIN_PURCHASE_USD", DEFAULT_PRICING.minPurchase),
    maxPurchase: usd("AGENT_CREDIT_MAX_PURCHASE_USD", DEFAULT_PRICING.maxPurchase),
    startingGrant: usd("AGENT_CREDIT_GRANT_USD", DEFAULT_PRICING.startingGrant),
    maxStorageBytes: gigabytes("AGENT_MAX_STORAGE_GB", DEFAULT_PRICING.maxStorageBytes),
    free: { hourlySpend: usd("AGENT_FREE_HOURLY_SPEND_USD", DEFAULT_PRICING.free.hourlySpend), maxStorageBytes: gigabytes("AGENT_FREE_MAX_STORAGE_GB", DEFAULT_PRICING.free.maxStorageBytes) },
    tiers: env.AGENT_USAGE_TIERS === undefined ? DEFAULT_PRICING.tiers : usageTiers(env.AGENT_USAGE_TIERS),
  };
  if (pricing.minPurchase < micros(0.5) || pricing.maxPurchase < pricing.minPurchase) throw new Error("AGENT_CREDIT_MIN_PURCHASE_USD must be at least 0.50 (Stripe's minimum) and at most AGENT_CREDIT_MAX_PURCHASE_USD");
  return pricing;
}

/**
 * AGENT_USAGE_TIERS: a JSON array of `{name, paidUsd, busyAgents}`, by ascending `paidUsd`, the first at 0
 * (a tenant that has paid nothing). Each tier's `busyAgents` is a positive integer.
 */
export function usageTiers(text: string): UsageTier[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("AGENT_USAGE_TIERS must be JSON: [{\"name\", \"paidUsd\", \"busyAgents\"}, ...]"); }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("AGENT_USAGE_TIERS must be a non-empty array of tiers");
  const tiers = parsed.map((tier: any, index): UsageTier => {
    if (!tier || typeof tier !== "object" || typeof tier.name !== "string" || !tier.name.trim() || tier.name.length > 40) throw new Error(`AGENT_USAGE_TIERS[${index}] needs a name (at most 40 characters)`);
    if (typeof tier.paidUsd !== "number" || !Number.isFinite(tier.paidUsd) || tier.paidUsd < 0) throw new Error(`AGENT_USAGE_TIERS[${index}].paidUsd must be a non-negative number of USD`);
    if (!Number.isSafeInteger(tier.busyAgents) || tier.busyAgents < 1) throw new Error(`AGENT_USAGE_TIERS[${index}].busyAgents must be a positive integer`);
    return { name: tier.name, paid: micros(tier.paidUsd), busyAgents: tier.busyAgents };
  });
  if (tiers[0].paid !== 0) throw new Error("AGENT_USAGE_TIERS must start with a tier at paidUsd 0");
  if (tiers.some((tier, index) => index > 0 && tier.paid <= tiers[index - 1].paid)) throw new Error("AGENT_USAGE_TIERS must be in ascending paidUsd order");
  return tiers;
}

/** The tier a tenant that has paid `paid` (micro-USD, net of refunds) is in, and the next one up, if any. */
export function usageTier(tiers: UsageTier[], paid: number): { tier: UsageTier; next?: UsageTier } {
  // The first tier starts at 0: a tenant refunded more than it paid is in it too.
  const index = Math.max(0, tiers.findLastIndex(tier => paid >= tier.paid));
  return { tier: tiers[index], ...(index + 1 < tiers.length ? { next: tiers[index + 1] } : {}) };
}

/** The charge for `ms` of active agent time. */
export const activeCharge = (pricing: Pricing, ms: number) => Math.round(ms * pricing.agentHour / 3_600_000);

/** One day's charge for `bytes` stored, in a month of `days` days. */
export const storageCharge = (pricing: Pricing, bytes: number, days: number) => Math.round(bytes * pricing.storageGbMonth / 1e9 / days);

/** The fee on buying `amount` of credit, rounded to the cent, as Stripe charges whole cents. */
export const purchaseFee = (pricing: Pricing, amount: number) => Math.round(amount * pricing.purchaseFeeBps / 10_000 / 10_000) * 10_000;
