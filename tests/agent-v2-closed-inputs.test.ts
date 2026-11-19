import assert from "node:assert/strict";
import { test } from "node:test";
import { proveClosedInputHistory, type SourceSnapshot } from "../src/agent-v2-closed-inputs.ts";
import { resumeId } from "../src/v1-client-state.ts";
import type { RequestMethod } from "../shared/client-protocol.ts";

const tenant = "camel-bots";
const agent = "client_fixture";
const inputId = (value: number) => `inp_${value.toString(16).padStart(32, "0")}`;
const resume = resumeId("original");
const continuation = resumeId(resume);
const item = (index: number, requestId: string, at: number): SourceSnapshot["inputs"][number] => ({
  id: inputId(index), tenant, agent, requestId, toolCallId: `call-${index}`, version: 2, blocking: true,
  state: "answered", deliveryPending: false, answer: { at, action: "accept", by: {} },
});
const receipt = (id: string, method: RequestMethod, time: number, result: object,
  suspension?: string): SourceSnapshot["receipts"][number] => ({
  id, method, fingerprint: "fixture", state: "completed", startedAt: time, began: time, endedAt: time + 2, outcome: { result },
  ...(suspension ? { suspension } : {}),
});
const stopped = (...rows: number[]) => ({ stopped: "input_required", inputs: rows.map(index => ({ id: inputId(index) })) });
const ok = { reply: "done" };
const pi = { active: false, running: false, awaiting: [], completedPromptSubmissions: new Set<string>() };
const nested = (): SourceSnapshot => ({
  tenant, agent, pi,
  inputs: [item(1, "original", 6), item(2, resume, 11)],
  receipts: [receipt("original", "prompt", 1, stopped(1)), receipt(resume, "resume", 6, stopped(2), "original"),
    receipt(continuation, "resume", 11, ok, resume)],
});
const failed = (snapshot: SourceSnapshot, reason: string) => assert.deepEqual(proveClosedInputHistory(snapshot), { ok: false, reason });

test("proves every link in a nested suspension chain", () => {
  assert.deepEqual(proveClosedInputHistory(nested()), { ok: true });
  const snapshot = nested();
  failed({ ...snapshot, inputs: [snapshot.inputs[0]] }, "nested_suspension_unverified");
  failed({ ...snapshot, receipts: snapshot.receipts.slice(0, 2) }, "continuation_unverified");
  failed({ ...snapshot, receipts: [snapshot.receipts[0], receipt(resume, "resume", 6, stopped(3), "original"), snapshot.receipts[2]] },
    "suspension_unverified");
});

test("the answer may be durable before its continuation is admitted", () => {
  const snapshot = nested();
  failed({ ...snapshot, inputs: [snapshot.inputs[0]], receipts: [snapshot.receipts[0]] }, "continuation_unverified");
  failed({ ...snapshot, receipts: [...snapshot.receipts.slice(0, 2), { ...snapshot.receipts[2], state: "running" }] }, "receipt_open_or_unverified");
  failed({ ...snapshot, receipts: [...snapshot.receipts.slice(0, 2), { ...snapshot.receipts[2], suspension: "wrong" }] }, "continuation_unverified");
  failed({ ...snapshot, receipts: [...snapshot.receipts.slice(0, 2), { ...snapshot.receipts[2], outcome: { uncertain: true, error: "Unknown result" } }] },
    "continuation_unverified");
});

test("requires a durably landed superseding prompt matching the settlement window", () => {
  const input = { ...item(1, "original", 6), state: "superseded", answer: { at: 6, action: "cancel", by: { system: "superseded" } } };
  const source: SourceSnapshot = { tenant, agent, pi, inputs: [input],
    receipts: [receipt("original", "prompt", 1, stopped(1)), receipt("next", "prompt", 5, ok)] };
  failed(source, "continuation_unverified");
  const after = { ...source, pi: { ...pi, completedPromptSubmissions: new Set(["next"]) } };
  assert.deepEqual(proveClosedInputHistory(after), { ok: true });
  failed({ ...after, receipts: [source.receipts[0], receipt("next", "prompt", 7, ok)] }, "continuation_unverified");
  failed({ ...after, inputs: [{ ...input, answer: { at: 6, action: "cancel", by: {} } }] }, "continuation_unverified");
  failed({ ...after, inputs: [input, item(2, "original", 6)] }, "continuation_unverified");
  failed({ ...after, receipts: [source.receipts[0], receipt("next", "prompt", 5, { taken: true })] }, "continuation_unverified");
});

test("rejects silent state gaps, foreign inputs, malformed receipts and outstanding intent", () => {
  const source = nested();
  failed({ ...source, pi: { ...pi, active: true } }, "pi_not_idle");
  failed({ ...source, pi: { ...pi, running: true } }, "pi_not_idle");
  failed({ ...source, pi: { ...pi, awaiting: ["call-2"] } }, "pi_not_idle");
  for (const changed of [
    { tenant: "other" }, { agent: "other" }, { version: 0 }, { state: "pending" }, { deliveryPending: true },
    { toolCallId: 1 as unknown as string }, { requestId: undefined as unknown as string },
  ]) {
    failed({ ...source, inputs: [{ ...source.inputs[0], ...changed }, source.inputs[1]] }, "input_open_or_unverified");
  }
  failed({ ...source, inputs: [source.inputs[0], source.inputs[0]] }, "input_open_or_unverified");
  failed({ ...source, receipts: [...source.receipts, { ...source.receipts[0], method: "unknown" as RequestMethod }] }, "receipt_open_or_unverified");
  failed({ ...source, receipts: [...source.receipts, source.receipts[0]] }, "receipt_open_or_unverified");
  failed({ ...source, receipts: [...source.receipts, receipt(undefined as unknown as string, "prompt", 20, ok)] },
    "receipt_open_or_unverified");
  failed({ ...source, receipts: [...source.receipts, { ...receipt("announce", "prompt", 20, ok), announce: true }] },
    "receipt_open_or_unverified");
});

test("only a proven lead can account for an additional copy of a suspended outcome", () => {
  const source = nested();
  const orphan = receipt("orphan", "prompt", 20, stopped(3));
  failed({ ...source, receipts: [...source.receipts, orphan] }, "unclaimed_suspension");
  failed({ ...source, inputs: [source.inputs[1]], receipts: source.receipts.slice(1) }, "unclaimed_suspension");
  const batchMember = { ...orphan, batchedInto: "original", outcome: { result: { ...stopped(1), batchedInto: "original" } } };
  assert.deepEqual(proveClosedInputHistory({ ...source, receipts: [...source.receipts, batchMember] }), { ok: true });
});

test("rejects an accepted idle steer despite its completed receipt", () => {
  const source = nested();
  const steer = { ...receipt("queued", "steer", 15, { queued: true, running: false }), params: { text: "next turn" } };
  failed({ ...source, receipts: [...source.receipts, steer] }, "receipt_open_or_unverified");
  assert.deepEqual(proveClosedInputHistory({ ...source, receipts: [...source.receipts, { ...steer, params: undefined }] }), { ok: true });
});
