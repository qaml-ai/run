import type { Api, Model } from "@earendil-works/pi-ai";
import type { AttemptEstimate } from "./model-attempt.ts";
import { platformUsage, usageMissing } from "./platform-pricing.ts";

/** The same catalog-pricing diagnostic the source host records for untrusted usage. */
export function logUntrustedModelUsage(
  tenant: string, agent: string, model: Model<Api>, usage: Record<string, any>,
  estimate: AttemptEstimate, chars: number, completed: boolean,
) {
  const priced = platformUsage(usage, model.provider, model.id,
    usageMissing(usage) || !completed ? { inputTokens: estimate.inputTokens, chars, completed } : undefined);
  if (priced.estimated || !priced.known) console.log(JSON.stringify({
    type: "platform_usage_untrusted", tenant, agent, provider: model.provider, model: model.id,
    estimated: priced.estimated, known: priced.known, aborted: !completed,
    reportedOutputTokens: usage.output ?? 0, billedOutputTokens: priced.usage.output ?? 0, usd: priced.usage.cost.total,
  }));
}
