import { createServer, type Server } from "node:http";

/** What the model answers one request with: a message delta, and how (`delayMs` before it; `stall` never ends; `status` refuses). */
export type Answer = { content?: string; tool_calls?: unknown[]; usage?: { prompt_tokens: number; completion_tokens: number }; delayMs?: number; stall?: boolean; status?: number };

/** One request the fake model served: who asked (the simulated host), what it asked for, and when (virtual ms). */
export type Served = { from: string; at: number; body: any; answer: Answer };

/**
 * An OpenAI-compatible model provider (what the runtime calls for `openrouter/...` models), answering each request with
 * `respond`. Its log of what it served, and to which node, is the ground truth the checkers hold the runtime's own
 * records against: who made model calls, and when.
 */
export function fakeModel(respond: (body: any, served: Served[]) => Answer, hostOf: (address: string) => string | undefined): { server: Server; served: Served[] } {
  const served: Served[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const answer = respond(body, served);
    served.push({ from: hostOf(req.socket.remoteAddress ?? "") ?? "unknown", at: Date.now(), body, answer });
    if (answer.delayMs) await new Promise(resolve => setTimeout(resolve, answer.delayMs));
    if (answer.status) { res.writeHead(answer.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Refused", type: "server_error" } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (answer.stall) return;
    const { usage, delayMs: _delay, stall: _stall, status: _status, ...delta } = answer;
    for (const [content, finish] of [[{ role: "assistant", ...delta }, null], [{}, delta.tool_calls ? "tool_calls" : "stop"]] as const) {
      res.write(`data: ${JSON.stringify({ id: "sim", object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason: finish }], ...(finish ? { usage: usage ?? { prompt_tokens: 1, completion_tokens: 1, cost: 0 } } : {}) })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  return { server, served };
}
