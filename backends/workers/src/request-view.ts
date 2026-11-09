import { digest } from "./api-contract.ts";

/** Keep queued input and the runtime's billing/task bookkeeping off the wire. */
export async function requestView<
  T extends { state: string; fingerprint: string },
>(record: T) {
  const {
    params: _params,
    sharedAgent: _sharedAgent,
    heldForInput: _heldForInput,
    inputAdmissionRetry: _inputAdmissionRetry,
    configurationOrder: _configurationOrder,
    configurationOrigin: _configurationOrigin,
    configurationWait: _configurationWait,
    configurationWaitSequence: _configurationWaitSequence,
    replaceConfiguration: _replaceConfiguration,
    billing: _billing,
    usageBaseline: _usageBaseline,
    task: _task,
    piId: _piId,
    agentSpendAt: _agentSpendAt,
    accepted: _accepted,
    admitted: _admitted,
    batchHeld: _batchHeld,
    fingerprint,
    ...visible
  } = record as T & Record<string, unknown>;
  const outcome = visible.outcome as { error?: unknown; result?: { error?: unknown } } | undefined;
  const error = typeof outcome?.result?.error === "string" ? outcome.result.error : outcome?.error;
  return {
    ...visible,
    ...(typeof error === "string" ? { error, status: 'failed' } : {}),
    ...((visible.outcome as { result?: { stopped?: string } } | undefined)?.result?.stopped ? { stopped: (visible.outcome as { result: { stopped: string } }).result.stopped } : {}),
    ...((visible.outcome as { result?: { stopped?: string } } | undefined)?.result?.stopped === "spend_limit" ? { status: "paused", stoppedReason: "budget_reached" } : {}),
    state: record.state === "queued" ? "running" : record.state,
    fingerprint: await digest(fingerprint),
  };
}
