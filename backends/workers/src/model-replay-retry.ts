import type { AssistantMessage } from "@earendil-works/pi-ai";
import { DEFAULT_RETRY } from "../../../src/limits.ts";
import { modelFailure, type ModelFailure } from "./model-errors.ts";

export type ModelRetryEvent =
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; failure: ModelFailure }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string; failure?: ModelFailure };

/** DeepSeek's replay refusal is retryable in the source host but not in Pi's generic 400 classifier. */
export class ModelReplayRetry {
  private request?: string;
  private failed = 0;
  private pending = 0;
  private emit?: (event: ModelRetryEvent) => void | Promise<void>;
  constructor(emit?: (event: ModelRetryEvent) => void | Promise<void>) { this.emit = emit; }

  begin(request: string) {
    if (request === this.request) return;
    this.request = request;
    this.failed = this.pending = 0;
  }

  async retry(message: AssistantMessage, signal?: AbortSignal) {
    const attempt = ++this.failed;
    const failure = modelFailure(message, { ownEndpoint: false });
    if (attempt > DEFAULT_RETRY.maxAttempts) {
      await this.emit?.({ type: "auto_retry_end", success: false, attempt: attempt - 1, finalError: message.errorMessage, failure });
      this.pending = 0;
      return false;
    }
    const delayMs = DEFAULT_RETRY.baseDelayMs * 2 ** (attempt - 1);
    await this.emit?.({ type: "auto_retry_start", attempt, maxAttempts: DEFAULT_RETRY.maxAttempts, delayMs, errorMessage: message.errorMessage ?? "Unknown error", failure });
    this.pending = attempt;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delayMs);
      signal?.addEventListener("abort", abort, { once: true });
    });
    return true;
  }

  async success() {
    if (!this.pending) return;
    await this.emit?.({ type: "auto_retry_end", success: true, attempt: this.pending });
    this.pending = 0;
  }
}
