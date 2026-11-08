import assert from "node:assert/strict";
import test from "node:test";
import { BatchRuns } from "../src/batch-runs.ts";

const prompt = (requestId: string, timestamp: number, batch = true) => ({ kind: "camel.prompt", data: { requestId, ...(batch ? { batch: true } : {}) }, model: [{ role: "user", content: requestId, timestamp }] }) as any;
const answer = (timestamp: number) => ({ kind: "pi.assistant", data: {}, model: [{ role: "assistant", content: [], timestamp }] }) as any;
/** Which request each answer is charged to, as usageForRequest attributes it; `run` names the Pi run that placed each prompt (its settled answer). */
const charged = (entries: any[], run: Record<string, string>) => { const runs = new BatchRuns(); let active: string | undefined; const out: string[] = [];
  for (const entry of entries) {
    const joined = entry.kind === "camel.prompt" && runs.lead !== undefined && run[runs.lead] === run[entry.data.requestId];
    if (runs.starts(entry, joined)) active = entry.data.requestId; if (entry.model.some((m: any) => m.role === "assistant")) out.push(active!);
  } return out; };

test("review: a runtime message Pi places at the batch's boundary takes the batch's usage from its lead", () => {
  // One Pi run: follow-ups p1, p2 and an agent's message (followUp, 'own') placed together at T, then the answer.
  assert.deepEqual(charged([prompt("p1", 5), prompt("p2", 5), prompt("msg_x", 5, false), answer(9)], { p1: "answer:9", p2: "answer:9", msg_x: "answer:9" }), ["p1"]);
});

test("review: a failed batch run (no answer entry) and a later run placed in the same millisecond are one batch", () => {
  // Run 1: p1+p2 at T fails with model_error (Pi appends no entry). Run 2: p3 placed at T too.
  assert.deepEqual(charged([prompt("p1", 5), prompt("p2", 5), prompt("p3", 5), answer(9)], { p1: "alone:p1", p2: "alone:p2", p3: "answer:9" }), ["p3"]);
});
