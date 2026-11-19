import type { RequestRecord } from "../shared/client-protocol.ts";
import { REQUEST_METHODS, RUN_METHODS, resumeId, validId } from "./v1-client-state.ts";

type InputRow = {
  id: string;
  tenant: string;
  agent: string;
  requestId: string;
  toolCallId: string;
  version: number;
  blocking: boolean;
  state: string;
  deliveryPending: boolean;
  answer?: { at?: unknown; action?: unknown; by?: { system?: unknown } };
};

export type SourceSnapshot = {
  tenant: string;
  agent: string;
  inputs: readonly InputRow[];
  receipts: readonly RequestRecord[];
  pi: {
    active: boolean;
    running: boolean;
    awaiting: readonly string[];
    completedPromptSubmissions: ReadonlySet<string>;
  };
};

const finalStates = new Set(["answered", "declined", "cancelled", "expired", "superseded", "withdrawn"]);
const validTime = (at: unknown): at is number => typeof at === "number" && Number.isSafeInteger(at) && at > 0;

function settledResult(receipt: RequestRecord | undefined): Record<string, unknown> | undefined {
  if (!receipt || !validTime(receipt.began) || !validTime(receipt.endedAt) || receipt.endedAt < receipt.began ||
    !receipt.outcome || receipt.outcome.uncertain || receipt.outcome.error != null || receipt.handedOff ||
    !receipt.outcome.result || typeof receipt.outcome.result !== "object" || Array.isArray(receipt.outcome.result)) return;
  const result = receipt.outcome.result as Record<string, unknown>;
  if (result.error != null) return;
  return result;
}

function matchesSuspendedInputs(result: Record<string, unknown>, inputs: readonly InputRow[]) {
  if (result.stopped !== "input_required" || !Array.isArray(result.inputs)) return false;
  const rowIds = new Set(inputs.map(row => row.id));
  const ids = result.inputs.map(input => input?.id);
  // An item can settle before the stopped outcome is committed, so the public receipt can show fewer pending items.
  return ids.length === new Set(ids).size && ids.every(id => typeof id === "string" && rowIds.has(id));
}

function closedBySupersedingPrompt(
  origin: RequestRecord, inputs: readonly InputRow[], landedPrompts: readonly RequestRecord[],
) {
  // With any user answer in the group, replay compatibility still needs that suspension's original resume receipt.
  if (!inputs.every(input => input.state === "superseded" && input.answer?.by?.system === "superseded")) return false;
  const { first, last } = inputs.reduce(({ first, last }, input) => {
    const at = Number(input.answer?.at);
    return { first: Math.min(first, at), last: Math.max(last, at) };
  }, { first: Infinity, last: -Infinity });
  return landedPrompts.some(prompt => prompt.id !== origin.id && prompt.startedAt! <= first &&
    prompt.began! >= origin.endedAt! && prompt.endedAt! >= last);
}

/** Pure validation of a read-only source snapshot. The caller must compare its durable revisions under the fence. */
export function proveClosedInputHistory(snapshot: SourceSnapshot): { ok: true } | { ok: false; reason: string } {
  const { tenant, agent, inputs, receipts, pi } = snapshot;
  if (!tenant || !agent || pi.active !== false || pi.running !== false || !Array.isArray(pi.awaiting) || pi.awaiting.length) {
    return { ok: false, reason: "pi_not_idle" };
  }

  const groups = new Map<string, InputRow[]>();
  const inputIds = new Set<string>();
  for (const input of inputs) {
    if (input.tenant !== tenant || input.agent !== agent || typeof input.id !== "string" || !/^inp_[a-f0-9]{32}$/.test(input.id) ||
      inputIds.has(input.id) || !validId(input.requestId) || typeof input.toolCallId !== "string" || !input.toolCallId ||
      !Number.isSafeInteger(input.version) || input.version < 1 || typeof input.blocking !== "boolean" ||
      !finalStates.has(input.state) || input.deliveryPending !== false || !validTime(input.answer?.at) ||
      (input.answer.action !== "accept" && input.answer.action !== "decline" && input.answer.action !== "cancel") ||
      !input.answer.by || typeof input.answer.by !== "object" || Array.isArray(input.answer.by)) {
      return { ok: false, reason: "input_open_or_unverified" };
    }
    inputIds.add(input.id);
    if (!input.blocking) continue;
    const group = groups.get(input.requestId) ?? [];
    group.push(input);
    groups.set(input.requestId, group);
  }

  const byId = new Map<string, RequestRecord>();
  for (const receipt of receipts) {
    if (!validId(receipt.id) || !REQUEST_METHODS.includes(receipt.method) || byId.has(receipt.id) ||
      receipt.state !== "completed" || receipt.heldForInput || receipt.handedOff || receipt.announce ||
      (receipt.method === "steer" && receipt.params !== undefined)) {
      return { ok: false, reason: "receipt_open_or_unverified" };
    }
    byId.set(receipt.id, receipt);
  }
  const landedPrompts = receipts.filter(receipt => {
    if (receipt.method !== "prompt" || !validTime(receipt.startedAt) || receipt.startedAt > (receipt.began ?? 0) ||
      !pi.completedPromptSubmissions.has(receipt.id) || receipt.steeredInto || receipt.batchedInto) return false;
    const result = settledResult(receipt);
    return !!result && result.taken !== true && !result.batchedInto && !result.steeredInto;
  });
  const linked = new Map<string, string>();
  for (const [id, group] of groups) {
    const origin = byId.get(id);
    const originResult = settledResult(origin);
    if (!origin || !RUN_METHODS.includes(origin.method) || !originResult || !matchesSuspendedInputs(originResult, group)) {
      return { ok: false, reason: "suspension_unverified" };
    }
    const resume = byId.get(resumeId(id));
    if (!resume && closedBySupersedingPrompt(origin, group, landedPrompts)) continue;
    const result = settledResult(resume);
    if (!resume || resume.method !== "resume" || resume.suspension !== id || !result ||
      resume.began! < origin.endedAt! || group.some(input => Number(input.answer?.at) > resume.began!)) {
      return { ok: false, reason: "continuation_unverified" };
    }
    if (result.stopped === undefined) continue;
    if (result.stopped !== "input_required" || !groups.has(resume.id)) {
      return { ok: false, reason: "nested_suspension_unverified" };
    }
    linked.set(id, resume.id);
  }

  const nested = new Set(linked.values());
  for (const receipt of receipts) {
    // Batching copies the lead's outcome onto every member, but only the lead owns the actual suspension.
    const result = receipt.outcome?.result as Record<string, unknown> | undefined;
    if (result?.stopped !== "input_required" || (groups.has(receipt.id) &&
      (receipt.method !== "resume" || nested.has(receipt.id)))) continue;
    const lead = receipt.batchedInto && groups.get(receipt.batchedInto);
    if (receipt.method !== "prompt" || !lead || result.batchedInto !== receipt.batchedInto ||
      !matchesSuspendedInputs(result, lead)) return { ok: false, reason: "unclaimed_suspension" };
  }

  const visited = new Set<string>();
  for (const start of groups.keys()) {
    const path = new Set<string>();
    for (let id: string | undefined = start; id && !visited.has(id); id = linked.get(id)) {
      if (path.has(id)) return { ok: false, reason: "suspension_cycle" };
      path.add(id);
    }
    for (const id of path) visited.add(id);
  }
  return { ok: true };
}
