import type { AssistantMessage } from '@earendil-works/pi-ai';
import { errorClass } from './model-error-classification.ts';
import { modelFailure, type FailureContext, type ModelFailure } from './model-errors.ts';
import { modelKeyFailure } from './model-key-failure.ts';
import { isStalled } from './model-stream-failure.ts';

export type RunFailure = { result: { error: string; code?: string; stopped?: string; modelError?: ModelFailure; servedModel?: string } };
export interface RunFailureOptions {
  reason?: string;
  last?: AssistantMessage;
  context?: FailureContext;
  aborted?: boolean;
  outputExpected?: boolean;
  hasOutput?: boolean;
}
/** Keep model faults distinct from caller cancellation and the runtime's own limits. */
export function projectRunFailure(options: RunFailureOptions): RunFailure | undefined {
  const { last } = options;
  const failed = last?.stopReason === 'error' || last?.stopReason === 'aborted';
  const error = options.reason || (failed ? last?.errorMessage : undefined);
  if (!error && !(options.outputExpected && !options.hasOutput)) return;
  if (!error) return { result: { error: 'The model ended its turn without calling final_output, so the run has no output in its schema', code: 'output_missing' } };
  const result: RunFailure['result'] = { error };
  if (options.aborted) result.code = 'aborted';
  else if (last?.stopReason === 'aborted' || /^(?:The run was aborted|Request was aborted|aborted|cancelled|canceled)(?:\b|$)/i.test(error)) result.code = /^cancel[le]+d$/i.test(error) ? 'cancelled' : 'aborted';
  else if (/\bcontext_too_large\b/.test(error)) { result.code = 'context_too_large'; result.stopped = 'turn_limit'; }
  else if (/\b(?:turn_limit|max(?:imum)? (?:turns|responses)|turn limit|response limit)\b/i.test(error)) { result.code = 'turn_limit'; result.stopped = 'turn_limit'; }
  else if (/\bspend_limit\b|spend limit/i.test(error)) { result.code = 'spend_limit'; result.stopped = 'spend_limit'; }
  else if (isStalled(error)) result.code = 'model_stream_stalled';
  else if (error === 'restart_limit') result.code = 'runtime_restart';
  else if (errorClass(error) === 'runtime_restart' || errorClass(error) === 'resume_limit') result.code = errorClass(error);
  if (last && failed && result.code !== 'aborted' && result.code !== 'cancelled') {
    result.code ??= 'model_error';
    const key = modelKeyFailure(error, { provider: last.provider, id: last.model });
    if (key) Object.assign(result, key);
    result.modelError = modelFailure({ ...last, errorMessage: error }, options.context ?? { ownEndpoint: false });
    result.servedModel = `${last.provider}/${last.model}`;
  }
  return { result };
}
