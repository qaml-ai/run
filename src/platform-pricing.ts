import { calculateCost, type Api, type Model } from "@earendil-works/pi-ai";
import { getModel, getModels } from "./pi-catalog.ts";

/** Token counts and costs as a response reports them; `cost` and `providerCost` are what billing reads (`usageCost`). */
type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; cost?: Record<string, number>; providerCost?: number; [key: string]: unknown };

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** The catalog's model, a routing variant (`…:nitro`) priced as its base. */
function catalogModel(provider: string, id: string): Model<Api> | undefined {
  return getModel(provider, id) ?? getModel(provider, id.replace(/:[a-z]+$/, ""));
}

/** For a model the catalog lacks: the provider's dearest rates, and the largest window and reply. */
function dearest(provider: string): Model<Api>["cost"] & { contextWindow: number; maxTokens: number } {
  const models = getModels(provider);
  const most = (pick: (model: Model<Api>) => number, floor: number) => Math.max(floor, ...models.map(pick).filter(Number.isFinite));
  return {
    input: most(model => model.cost.input, 15), output: most(model => model.cost.output, 75),
    cacheRead: most(model => model.cost.cacheRead, 1.5), cacheWrite: most(model => model.cost.cacheWrite, 18.75),
    contextWindow: most(model => model.contextWindow, 200_000), maxTokens: most(model => model.maxTokens, 32_000),
  };
}

/** A model's rates in USD per million tokens (micro-USD per token), from the catalog; the provider's dearest for a model it lacks. */
export function catalogRates(provider: string, id: string): { input: number; output: number } {
  const { input, output } = catalogModel(provider, id)?.cost ?? dearest(provider);
  return { input, output };
}

/**
 * USD per million tokens a call its end user pays for is priced at when neither its model nor the catalog has a price:
 * a mid-range model's (Sonnet-class). Never the dearest: a hold at the dearest rates would refuse every call of people
 * on a small allowance, an outage from one model declared without pricing.
 */
export const UNPRICED_COST: Readonly<Model<Api>["cost"]> = Object.freeze({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });

/**
 * What a call its end user pays for is priced at when its model has no price (a tenant's model declared without pricing,
 * a tenant endpoint's, at no cost to the tenant): the catalog's for the model, by its own provider or the one its id
 * names (`openrouter/<model>` on an endpoint); else UNPRICED_COST. Undefined: the catalog prices it at zero (a free
 * model), the only way such a call is free.
 */
export function unpricedCost(provider: string, id: string): Model<Api>["cost"] | undefined {
  const [inner, ...rest] = id.split("/");
  const known = catalogModel(provider, id) ?? (rest.length ? catalogModel(inner, rest.join("/")) : undefined);
  if (!known) return UNPRICED_COST;
  return known.cost.input > 0 || known.cost.output > 0 ? known.cost : undefined;
}

/** A model's rates in USD per million tokens as the catalog lists them; undefined for a model it lacks. */
export function catalogCost(provider: string, id: string): Model<Api>["cost"] | undefined {
  return catalogModel(provider, id)?.cost;
}

/** `usage`'s tokens at `cost` (USD per million tokens), in USD. */
export function costAt(cost: Model<Api>["cost"], usage: Usage): number {
  return (count(usage.input) * cost.input + count(usage.output) * cost.output + count(usage.cacheRead) * cost.cacheRead + count(usage.cacheWrite) * cost.cacheWrite) / 1_000_000;
}

/** Whether a response reported nothing to bill it by: no token counts, and no cost of the provider's own. */
export function usageMissing(usage: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; providerCost?: unknown } | undefined): boolean {
  if (!usage) return true;
  const reported = typeof usage.providerCost === "number" && Number.isFinite(usage.providerCost) && usage.providerCost > 0;
  return !reported && count(usage.input) + count(usage.output) + count(usage.cacheRead) + count(usage.cacheWrite) === 0;
}

/**
 * A response on a platform key, priced from the runtime's catalog when it is billed: never from the agent's model
 * as stored, whose prices are not the tenant's to set. A cost the provider reported itself (`providerCost`) still
 * comes first. A response with no token counts and no provider cost (its usage never arrived, or was suppressed) is
 * charged an estimate, `estimated`: the host's input estimate and the characters it streamed at two a token
 * (`estimate`; none given, nothing). One aborted before the provider sent its usage (`estimate` not `completed`) also
 * uses the estimate wherever reported counts fall short: an interrupted output count is a lower bound, so the larger of
 * it and the reply estimate is used, and the input estimate where no input was reported. Provider-reported cost takes
 * precedence, and completed responses keep their counts.
 */
export function platformUsage<T extends Usage>(usage: T, provider: string, id: string, estimate?: { chars: number; inputTokens?: number; completed?: boolean }): { usage: T; estimated: boolean; known: boolean } {
  const model = catalogModel(provider, id);
  const rates = model ? { ...model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens } : dearest(provider);
  const reported = typeof usage.providerCost === "number" && Number.isFinite(usage.providerCost) && usage.providerCost > 0;
  const missing = usageMissing(usage);
  const outputEstimate = Math.ceil(count(estimate?.chars) / 2), inputEstimate = Math.min(rates.contextWindow, count(estimate?.inputTokens));
  const tokens = missing
    ? { input: inputEstimate, output: outputEstimate, cacheRead: 0, cacheWrite: 0 }
    : { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite), cacheWrite1h: Math.min(count(usage.cacheWrite1h), count(usage.cacheWrite)) };
  // A stream may report one or two output tokens at its start and never update them before cancellation.
  // Nonzero partial usage is not final usage. Never reduce a count the provider has already reported.
  const aborted = !!estimate && !estimate.completed;
  const partialOutput = !reported && aborted && outputEstimate > tokens.output;
  if (partialOutput) tokens.output = outputEstimate;
  const partialInput = !reported && aborted && tokens.input + tokens.cacheRead + tokens.cacheWrite === 0 && inputEstimate > 0;
  if (partialInput) tokens.input = inputEstimate;
  const estimated = missing || partialOutput || partialInput;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  calculateCost({ cost: rates } as unknown as Model<Api>, { ...tokens, totalTokens: 0, cost } as never);
  return { usage: { ...usage, ...(estimated ? tokens : {}), cost }, estimated, known: !!model };
}
