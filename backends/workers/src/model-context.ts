import type { Api, Model } from "@earendil-works/pi-ai";

/** Pi's native compaction observes the configured window on each model lookup. */
export function boundedModel<T extends Model<Api>>(model: T, contextTokens?: number): T {
  return contextTokens === undefined ? model : { ...model, contextWindow: Math.min(model.contextWindow, contextTokens) };
}
