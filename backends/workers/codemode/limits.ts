import type { CodemodeRemoteExchange, CodemodeRemoteMessage } from "@earendil-works/pi-codemode/portable";
import { SANDBOX_LIMITS } from "../../../src/limits.ts";

// QuickJS counts interrupt polls because Workers clocks freeze during synchronous code.
// Keep non-yielding scripts below the isolate CPU reset threshold. This is not a wall-clock CPU limit.
export const SANDBOX_INTERRUPT_BUDGET = 10_000;

/** Enforce the existing v8 bridge budgets at the remote boundary, before invoking host capabilities. */
export function boundedExchange(exchange: CodemodeRemoteExchange, workflow = false): CodemodeRemoteExchange {
  const maxCalls = workflow ? SANDBOX_LIMITS.workflowToolCalls : SANDBOX_LIMITS.toolCalls;
  const maxConcurrent = workflow ? SANDBOX_LIMITS.workflowConcurrentTools : SANDBOX_LIMITS.concurrentTools;
  const maxArgs = workflow ? SANDBOX_LIMITS.workflowArgumentBytes : SANDBOX_LIMITS.argumentBytes;
  const maxResultBytes = workflow ? SANDBOX_LIMITS.workflowToolBytes : SANDBOX_LIMITS.totalToolBytes;
  let calls = 0, pending = 0, totalResults = 0, textBytes = 0, outputEvents = 0, cut = false, failed = false, images = 0, imageBytes = 0, imageCut = false;
  const size = (text: string | undefined) => text === undefined ? 0 : new TextEncoder().encode(text).byteLength;
  return async messages => {
    if (failed) return { type: "stop" };
    const call = messages.find(message => message.type === "call");
    const fail = async (message: string) => {
      failed = true;
      await exchange([{ type: "failure", error: { kind: "sandbox", message } }]);
      return { type: "stop" as const };
    };
    if (call?.type === "call") {
      if (++calls > maxCalls) return fail("Pi tool call limit or invalid call id");
      if (pending >= maxConcurrent) return fail("Too many concurrent tool calls");
      if (size(call.args) > maxArgs) return fail("Pi call arguments exceed limit");
      pending++;
    }
    const kept: CodemodeRemoteMessage[] = [];
    for (const message of messages) {
      if (message.type === "output" && message.item.type === "image") {
        if (images >= SANDBOX_LIMITS.outputImages || imageBytes + message.item.data.length > SANDBOX_LIMITS.outputImageBytes) {
          if (!imageCut) kept.push({ type: "output", item: { type: "text", text: "[Images past 16, or past 8 MiB in all, were left out.]" } });
          imageCut = true; continue;
        }
        images++; imageBytes += message.item.data.length;
      }
      if (message.type === "output" && message.item.type === "text") {
        if (++outputEvents > SANDBOX_LIMITS.outputEvents || textBytes + size(message.item.text) > SANDBOX_LIMITS.maxOutputCharacters) {
          if (!cut && outputEvents <= SANDBOX_LIMITS.outputEvents) {
            const prefix = new TextDecoder().decode(new TextEncoder().encode(message.item.text).subarray(0, SANDBOX_LIMITS.maxOutputCharacters - textBytes), { stream: true });
            if (prefix) kept.push({ ...message, item: { ...message.item, text: prefix } });
          }
          if (!cut) kept.push({ type: "output", item: { type: "text", text: "[Output stops here: a script prints at most 1,024 times and 128,000 bytes. Return or write what you need instead.]" } });
          cut = true;
          continue;
        }
        textBytes += size(message.item.text);
      }
      kept.push(message);
    }
    try {
      const reply = await exchange(kept);
      if (reply?.type === "result" && reply.ok) {
        const bytes = size(reply.payload), most = SANDBOX_LIMITS.resultBytes - 1024;
        let error: string | undefined;
        if (bytes > most) error = `The result is ${bytes.toLocaleString("en-US")} bytes; a script gets at most ${most.toLocaleString("en-US")} from one call. Ask the tool for less.`;
        else if ((totalResults += bytes) > maxResultBytes) error = `This script's calls have returned more than ${maxResultBytes.toLocaleString("en-US")} bytes in all, the most one script gets. Ask for less, or split the work across scripts.`;
        if (error) return { ...reply, ok: false, payload: error };
      }
      return reply;
    } finally { if (call) pending--; }
  };
}
