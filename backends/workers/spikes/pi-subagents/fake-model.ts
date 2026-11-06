/**
 * A credential-free OpenAI-compatible model for the subagent load spike. It streams one SSE chunk per token at a
 * steady rate, so N children in one agent object receive realistic provider traffic. No upstream model is called.
 *
 * The conversation decides the reply:
 * - a parent prompt `fanout n=<N> ...` answers with N `subagent` tool calls, each carrying the child's parameters;
 * - a parent that got its tool results answers "done";
 * - a child (`child tps=<T> tokens=<K> tools=<C> ...`) makes C rounds of 50 tokens plus one `work` call, then answers
 *   with K tokens.
 */
type Part = { type?: string; text?: string };
type Message = { role: string; content?: string | Part[] | null; tool_calls?: unknown[] };
type Body = { model?: string; messages?: Message[]; stream?: boolean };

const text = (message?: Message) =>
  typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => part.text ?? "").join("");

/** `key=value` words of a prompt. */
export function params(prompt: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const match of prompt.matchAll(/\b([a-z]+)=(\d+)/g)) out[match[1]!] = Number(match[2]);
  return out;
}

const WORD = "lorem ";

type Plan = { tokens: number; tps: number; call?: { name: string; args: unknown }[] };

export function plan(body: Body): Plan {
  const messages = body.messages ?? [];
  const firstUser = messages.findIndex((message) => message.role === "user");
  const prompt = text(messages[firstUser]);
  // The task text sits at the end of a long-context child's message.
  const tail = prompt.slice(-400);
  const p = params(tail);
  const tps = p.tps ?? 50;
  const toolResults = messages.slice(firstUser + 1).filter((message) => message.role === "tool").length;
  if (tail.includes("fanout")) {
    if (toolResults > 0) return { tokens: 5, tps };
    const n = p.n ?? 1;
    const childArgs = `child tps=${tps} tokens=${p.tokens ?? 2000} tools=${p.tools ?? 3} ctx=${p.ctx ?? 0}`;
    return {
      tokens: 0,
      tps,
      call: Array.from({ length: n }, (_, index) => ({ name: "subagent", args: { task: `${childArgs} child=${index}` } })),
    };
  }
  const tools = p.tools ?? 3;
  if (toolResults < tools) return { tokens: 50, tps, call: [{ name: "work", args: { round: toolResults } }] };
  return { tokens: p.tokens ?? 2000, tps };
}

function promptTokens(body: Body) {
  let chars = 0;
  for (const message of body.messages ?? []) chars += text(message).length;
  return Math.ceil(chars / 4);
}

export function respond(request: Request): Promise<Response> | Response {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions"))
    return new Response("Not found", { status: 404 });
  return (async () => {
    const body = (await request.json()) as Body;
    const turn = plan(body);
    const usage = { prompt_tokens: promptTokens(body), completion_tokens: turn.tokens, total_tokens: 0 };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const id = `fake-${crypto.randomUUID()}`;
    const chunk = (delta: unknown, finish: string | null, extra?: object) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const interval = 1000 / Math.max(1, turn.tps);
    void (async () => {
      try {
        const started = Date.now();
        for (let index = 0; index < turn.tokens; index++) {
          const due = started + index * interval;
          const wait = due - Date.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          await writer.write(encoder.encode(chunk({ content: WORD }, null)));
        }
        if (turn.call) {
          const tool_calls = turn.call.map((call, index) => ({
            index,
            id: `call_${index}_${crypto.randomUUID().slice(0, 8)}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          }));
          await writer.write(encoder.encode(chunk({ tool_calls }, null)));
        }
        await writer.write(encoder.encode(chunk({}, turn.call ? "tool_calls" : "stop", { usage })));
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        await writer.close();
      } catch {
        await writer.abort().catch(() => {});
      }
    })();
    return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  })();
}

export default { fetch: respond };
