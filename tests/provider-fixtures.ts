import * as zlib from "node:zlib";
import { crc32 } from "node:zlib";
import { listen, type T } from "./runtime-server.ts";

/** Node has zstd (Pi's Codex client compresses its bodies with it); this @types/node predates it. */
const { zstdDecompressSync } = zlib as unknown as { zstdDecompressSync: (data: Buffer) => Buffer };

type Reply = { events: object[] } | { eventStream: Buffer } | { status: number; error: object };
/**
 * A tenant's pass-through gateway: records each request as it arrives (path, headers, the provider's
 * native body) and answers with the next scripted reply, SSE events or an HTTP error before any stream.
 */
export async function gateway(t: T, reply: (body: any, index: number) => Reply) {
  const requests: { path: string; headers: Record<string, any>; body: any }[] = [];
  const url = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString());
    requests.push({ path: req.url!, headers: req.headers, body });
    const next = reply(body, requests.length - 1);
    if ("status" in next) { res.writeHead(next.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: next.error })); return; }
    if ("eventStream" in next) { res.writeHead(200, { "Content-Type": "application/vnd.amazon.eventstream" }).end(next.eventStream); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of next.events) res.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  return { url: `${url}/agent-runtime/llm`, requests };
}

/** Anthropic Messages events for one response: its content blocks, then its stop reason and usage. */
export function anthropic(blocks: object[], stop: string, usage = { input_tokens: 10, output_tokens: 5 }) {
  const events: object[] = [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } }];
  blocks.forEach((block: any, index) => {
    if (block.type === "thinking") events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    if (block.type === "tool_use") events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    if (block.type === "text") events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    events.push({ type: "content_block_stop", index });
  });
  return { events: [...events, { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: usage.output_tokens } }, { type: "message_stop" }] };
}

/** OpenAI Responses events for one response of output items, and its usage. */
export function responses(items: object[], usage = { input_tokens: 10, output_tokens: 5 }) {
  const events: object[] = [{ type: "response.created", response: { id: "resp_1", status: "in_progress" } }];
  items.forEach((item: any, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item: item.type === "message" ? { ...item, content: [] } : item.type === "function_call" ? { ...item, arguments: "" } : item });
    if (item.type === "message") events.push({ type: "response.output_text.delta", output_index, content_index: 0, delta: item.content[0].text });
    if (item.type === "function_call") events.push({ type: "response.function_call_arguments.delta", output_index, delta: item.arguments });
    events.push({ type: "response.output_item.done", output_index, item });
  });
  return { events: [...events, { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens } } }] };
}
/** Bedrock ConverseStream events, as AWS event-stream frames: each `[type, body]` one message. */
export function converse(events: [string, object][]) {
  const u32 = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value >>> 0); return buffer; };
  const header = (name: string, value: string) => Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7, value.length >> 8, value.length & 255]), Buffer.from(value)]);
  return { eventStream: Buffer.concat(events.map(([type, body]) => {
    const headers = Buffer.concat([header(":event-type", type), header(":content-type", "application/json"), header(":message-type", "event")]);
    const payload = Buffer.from(JSON.stringify(body));
    const prelude = Buffer.concat([u32(16 + headers.length + payload.length), u32(headers.length)]);
    const frame = Buffer.concat([prelude, u32(crc32(prelude)), headers, payload]);
    return Buffer.concat([frame, u32(crc32(frame))]);
  })) };
}

