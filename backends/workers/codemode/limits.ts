import type { CodemodeRemoteExchange, CodemodeRemoteMessage, CodemodeRemoteRequest } from "@earendil-works/pi-codemode/portable";
import { SANDBOX_LIMITS } from "../../../src/limits.ts";
import { EXCHANGE_PROTOCOL, requestExchange, type ExchangeParameters, type ExchangeRequest } from "./exchange.ts";

export { SANDBOX_INTERRUPT_BUDGET } from "./exchange.ts";

/**
 * The sandbox's side of one execution: `serve` (the stock VM server) runs `request` under the caps it was made with,
 * at most their poll budget. Throws, before serving, for a request this sandbox cannot serve.
 */
export async function serveExchange(
  request: ExchangeRequest, exchange: CodemodeRemoteExchange,
  serve: (request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange) => Promise<void>,
): Promise<void> {
  const { parameters, hello } = requestExchange(request);
  const most = parameters.caps.interruptBudget;
  await serve({ data: request.data, interruptBudget: Math.min(request.interruptBudget ?? most, most) }, boundedExchange(exchange, parameters, hello));
}

/**
 * Enforce an exchange's caps at the remote boundary, before invoking host capabilities. Past `caps.inFlight` calls
 * out at once, a call waits its turn here, as v8-exec queues it in the guest: Promise.all over many calls works within
 * the script's `caps.calls`. With `hello`, the first batch sent opens with the protocol 2 hello.
 */
export function boundedExchange(upstream: CodemodeRemoteExchange, parameters: ExchangeParameters, hello = false): CodemodeRemoteExchange {
  const { calls: maxCalls, inFlight: maxConcurrent, argumentBytes: maxArgs, resultBytes: most, totalResultBytes: maxResultBytes } = parameters.caps;
  let greeted = !hello;
  // The hello is not a VM message, so it is typed as one only to cross the stock exchange.
  const exchange: CodemodeRemoteExchange = messages => {
    if (greeted) return upstream(messages);
    greeted = true;
    return upstream([{ type: "exchange", protocol: EXCHANGE_PROTOCOL } as unknown as CodemodeRemoteMessage, ...messages]);
  };
  const turns: (() => void)[] = [];
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
      if (size(call.args) > maxArgs) return fail("Pi call arguments exceed limit");
      while (pending >= maxConcurrent) await new Promise<void>(resolve => turns.push(resolve));
      if (failed) return { type: "stop" };
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
        const bytes = size(reply.payload);
        let error: string | undefined;
        if (bytes > most) error = `The result is ${bytes.toLocaleString("en-US")} bytes; a script gets at most ${most.toLocaleString("en-US")} from one call. Ask the tool for less.`;
        else if ((totalResults += bytes) > maxResultBytes) error = `This script's calls have returned more than ${maxResultBytes.toLocaleString("en-US")} bytes in all, the most one script gets. Ask for less, or split the work across scripts.`;
        if (error) return { ...reply, ok: false, payload: error };
      }
      return reply;
    } finally { if (call) { pending--; turns.shift()?.(); } }
  };
}
