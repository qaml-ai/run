import type { Api, Model } from "@earendil-works/pi-ai";

/** Pi's native compaction observes the configured window on each model lookup. */
export function boundedModel<T extends Model<Api>>(model: T, contextTokens?: number): T {
  return contextTokens === undefined ? model : { ...model, contextWindow: Math.min(model.contextWindow, contextTokens) };
}

/** The source runtime scales Pi's reserve and recent context to the selected model's window. */
export function modelCompactionSettings(model: Model<Api>, maxOutputTokens?: number | null, fixedTokens = 0) {
  const window = model.contextWindow;
  const limit = model.maxTokens || Infinity;
  const output = Math.min(maxOutputTokens ?? limit, limit);
  const reserveTokens = Math.min(Math.floor(window * 0.15), (Number.isFinite(output) ? output : 0) + 16_384);
  const keepRecentTokens = Math.max(1_000, Math.min(20_000, Math.floor(window * 0.25), window - reserveTokens - fixedTokens - Math.floor(window / 4)));
  return { enabled: true, reserveTokens, keepRecentTokens, backgroundTokens: 0 };
}
