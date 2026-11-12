import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getModel, tierCost } from "./model-catalog.ts";
import { costAt } from "./platform-pricing.ts";
import { modelFailure } from "./model-errors.ts";
import type { ModelRetryEvent } from "./model-replay-retry.ts";
import { STRONG_FLEX_WAIT_CAP_SECONDS } from "./model-policy.ts";

/**
 * How long a call asked on OpenRouter's flex tier waits for flex capacity before it moves to the default tier, by
 * default. Google's flex endpoint is Gemini 4 Carbon's cheapest, so OpenRouter has nothing to fall back to and answers
 * a capacity error (https://openrouter.ai/docs/guides/features/service-tiers.md): the runtime asks flex again with
 * backoff for this long, then the virtual model's next member (the same model on the default tier) takes the call.
 * Both agents and workflows are capped at 10 seconds of wall time; a workflow can only lower it (`flexWaitSeconds`).
 */
export const FLEX_WAIT_SECONDS = STRONG_FLEX_WAIT_CAP_SECONDS;
const FIRST_DELAY_MS = 2_000, MAX_DELAY_MS = 15_000;

/** The flex wait for a call: the request's `flexWaitSeconds`, else AGENT_FLEX_WAIT_SECONDS, else FLEX_WAIT_SECONDS, at most STRONG_FLEX_WAIT_CAP_SECONDS; 0 moves at once. */
export function flexWaitMs(env: { AGENT_FLEX_WAIT_SECONDS?: string }, requested?: number): number {
  const configured = env.AGENT_FLEX_WAIT_SECONDS === undefined || env.AGENT_FLEX_WAIT_SECONDS === "" ? NaN : Number(env.AGENT_FLEX_WAIT_SECONDS);
  const seconds = typeof requested === "number" && Number.isFinite(requested) && requested >= 0 ? requested : Number.isFinite(configured) && configured >= 0 ? configured : FLEX_WAIT_SECONDS;
  return Math.min(seconds, STRONG_FLEX_WAIT_CAP_SECONDS) * 1_000;
}

/** Whether a model is a member asked on flex (virtual-models.ts). */
export const asksFlex = (model: Model<Api>) => (model as { serviceTier?: string }).serviceTier === "flex";

/**
 * One call's wait for flex capacity: from its first refusal, asks again after 2 s, doubling to 15 s (with jitter), while
 * the window lasts. Each wait is said as Pi's auto-retry events are, so a watcher sees it.
 */
export class FlexWait {
  private deadline?: number;
  private started = 0;
  attempts = 0;
  private readonly windowMs: number;
  private readonly emit?: (event: ModelRetryEvent) => void | Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  constructor(windowMs: number, emit?: (event: ModelRetryEvent) => void | Promise<void>, now: () => number = Date.now, random: () => number = Math.random) {
    this.windowMs = windowMs; this.emit = emit; this.now = now; this.random = random;
  }

  /** How long the call has waited for flex. */
  waitedMs() { return this.deadline === undefined ? 0 : this.now() - this.started; }

  /** Waits before asking flex again and answers true; false once the window is spent (the call moves to the default tier). */
  async retry(message: AssistantMessage, signal?: AbortSignal): Promise<boolean> {
    if (this.deadline === undefined) { this.started = this.now(); this.deadline = this.started + this.windowMs; }
    const left = this.deadline - this.now();
    const failure = modelFailure(message, { ownEndpoint: false });
    if (left <= 0) {
      if (this.attempts) await this.emit?.({ type: "auto_retry_end", success: false, attempt: this.attempts, finalError: message.errorMessage, failure });
      return false;
    }
    const backoff = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** this.attempts);
    const delayMs = Math.max(0, Math.min(left, Math.round(backoff * (0.5 + this.random() / 2))));
    this.attempts++;
    await this.emit?.({ type: "auto_retry_start", attempt: this.attempts, maxAttempts: this.attempts + Math.ceil((left - delayMs) / MAX_DELAY_MS), delayMs, errorMessage: message.errorMessage ?? "Flex capacity unavailable", failure });
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delayMs);
      signal?.addEventListener("abort", abort, { once: true });
    });
    return true;
  }

  /** The call was answered on flex after waiting. */
  async success() {
    if (this.attempts) await this.emit?.({ type: "auto_retry_end", success: true, attempt: this.attempts });
  }
}

/**
 * What a response served on the default tier cost over flex for the same tokens (USD), for a call that moved there from
 * flex; undefined when the model has no flex prices.
 */
export function flexFallbackDeltaUsd(model: Model<Api>, usage: AssistantMessage["usage"]): number | undefined {
  const flex = tierCost(model.provider, model.id, "flex");
  const served = tierCost(model.provider, model.id, (usage as { serviceTier?: string }).serviceTier) ?? getModel(model.provider, model.id)?.cost;
  if (!flex || !served) return undefined;
  const tokens = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
  return Math.round((costAt(served, tokens) - costAt(flex, tokens)) * 1e9) / 1e9;
}
