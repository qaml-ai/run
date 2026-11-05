import { digest } from "./api-contract.ts";

/** Keep queued input and the runtime's billing/task bookkeeping off the wire. */
export async function requestView<
  T extends { state: string; fingerprint: string },
>(record: T) {
  const {
    params: _params,
    billing: _billing,
    task: _task,
    piId: _piId,
    agentSpendAt: _agentSpendAt,
    accepted: _accepted,
    admitted: _admitted,
    fingerprint,
    ...visible
  } = record as T & Record<string, unknown>;
  return {
    ...visible,
    ...((visible.outcome as { result?: { stopped?: string } } | undefined)?.result?.stopped ? { stopped: (visible.outcome as { result: { stopped: string } }).result.stopped } : {}),
    state: record.state === "queued" ? "running" : record.state,
    fingerprint: await digest(fingerprint),
  };
}
