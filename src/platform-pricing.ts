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
 * A response on a platform key, priced from the runtime's catalog when it is billed: never from the agent's model
 * as stored, whose prices are not the tenant's to set. A cost the provider reported itself (`providerCost`) still
 * comes first. A response with no token counts and no provider cost (usage suppressed) is charged as if it filled
 * the model's context window and wrote its longest reply: `estimated`. One aborted before the provider sent usage
 * (`aborted`) uses the host's input estimate and its partial reply at two characters a token, wherever reported
 * input counts are missing. An interrupted output count is a lower bound: the larger of it and the reply
 * estimate is used. Provider-reported cost takes precedence, and completed responses keep their counts.
 */
export function platformUsage<T extends Usage>(usage: T, provider: string, id: string, aborted?: { chars: number; inputTokens?: number }): { usage: T; estimated: boolean; known: boolean } {
  const model = catalogModel(provider, id);
  const rates = model ? { ...model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens } : dearest(provider);
  const reported = typeof usage.providerCost === "number" && Number.isFinite(usage.providerCost) && usage.providerCost > 0;
  const missing = !reported && count(usage.input) + count(usage.output) + count(usage.cacheRead) + count(usage.cacheWrite) === 0;
  const tokens = missing
    ? aborted ? { input: Math.min(rates.contextWindow, count(aborted.inputTokens)), output: Math.ceil(count(aborted.chars) / 2), cacheRead: 0, cacheWrite: 0 } : { input: rates.contextWindow, output: rates.maxTokens, cacheRead: 0, cacheWrite: 0 }
    : { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite), cacheWrite1h: Math.min(count(usage.cacheWrite1h), count(usage.cacheWrite)) };
  // A stream may report one or two output tokens at its start and never update them before cancellation.
  // Nonzero partial usage is not final usage. Never reduce a count the provider has already reported.
  const outputEstimate = aborted ? Math.ceil(count(aborted.chars) / 2) : 0;
  const partialOutput = !reported && !!aborted && outputEstimate > tokens.output;
  if (partialOutput) tokens.output = outputEstimate;
  const partialInput = !reported && !!aborted && tokens.input + tokens.cacheRead + tokens.cacheWrite === 0 && count(aborted.inputTokens) > 0;
  if (partialInput) tokens.input = Math.min(rates.contextWindow, count(aborted!.inputTokens));
  const estimated = missing || partialOutput || partialInput;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  calculateCost({ cost: rates } as unknown as Model<Api>, { ...tokens, totalTokens: 0, cost } as never);
  return { usage: { ...usage, ...(estimated ? tokens : {}), cost }, estimated, known: !!model };
}
