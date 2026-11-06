/** A deterministic, credential-free provider for the internal pilot probes. */
type Message = { role: string; content?: string | Array<{ type?: string; text?: string; image_url?: { url: string } }> };
type RequestBody = { model?: string; messages?: Message[]; stream?: boolean };
const content = (message?: Message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map(part => part.text ?? "").join("");
const tool = (name: string, args: unknown) => ({ role: "assistant", tool_calls: [{ index: 0, id: `pilot_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

export function reply(body: RequestBody) {
  const messages = body.messages ?? [];
  const userIndex = messages.findLastIndex(message => message.role === "user");
  const prompt = content(messages[userIndex]);
  const returned = messages.slice(userIndex + 1).findLast(message => message.role === "tool");
  if (returned) return { role: "assistant", content: `Tool result: ${content(returned)}` };
  if (prompt.startsWith("pilot:human")) return tool("ask_user", { questions: [{ question: "Approve the pilot smoke test?", header: "Approval", options: [{ label: "approved" }, { label: "rejected" }] }] });
  if (prompt.startsWith("pilot:code")) return tool("codemode", { code: 'await tools.write({path:"/workspace/pilot-code.txt",content:"pilot-codemode-ok"}); text((await tools.read({path:"/workspace/pilot-code.txt"})).content);' });
  if (prompt.startsWith("pilot:delegate")) return tool("delegate", { instructions: "You are the pilot smoke test helper.", task: "pilot:child" });
  if (prompt.startsWith("pilot:images")) {
    const images = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === "image_url");
    const inline = images.filter(part => part.image_url?.url.startsWith("data:image/"));
    const bytes = inline.map(part => atob(part.image_url!.url.split(",")[1]));
    const markers = bytes.filter(data => data.includes("camelrun:image:v1:")).length;
    return { role: "assistant", content: `Images received: ${images.length}; inline: ${inline.length}; markers: ${markers}; bytes: ${bytes.map(data => data.length).join(",")}` };
  }
  return { role: "assistant", content: `Echo: ${prompt}` };
}

export default {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/health" || request.method === "HEAD" || request.method === "GET") return Response.json({ service: "camelrun-pilot-fakemodel", deterministic: true });
    if (request.method !== "POST" || path !== "/v1/chat/completions") return new Response("Not found", { status: 404 });
    // Bound public input. This worker never proxies requests or uses a model key.
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 8 * 1024 * 1024) return new Response("Too large", { status: 413 });
    let body: RequestBody;
    try {
      const reader = request.body?.getReader();
      let size = 0; const chunks: Uint8Array[] = [];
      if (!reader) return new Response("Body required", { status: 400 });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); return new Response("Too large", { status: 413 }); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return new Response("Invalid JSON", { status: 400 }); }
    if (!Array.isArray(body.messages)) return new Response("Messages required", { status: 400 });
    const prompt = content(body.messages.findLast(message => message.role === "user"));
    if (prompt.startsWith("pilot-load:")) {
      const requested = Number(request.headers.get("x-pilot-delay-ms") ?? 1000);
      const delayMs = Number.isFinite(requested) ? Math.max(0, Math.min(15000, requested)) : 1000;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    const delta = reply(body);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.000015 };
    if (!body.stream) return Response.json({ id: "pilot-fake", object: "chat.completion", model: body.model, choices: [{ index: 0, message: delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage });
    const frames = [
      { id: "pilot-fake", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "pilot-fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage },
    ];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  },
};
