import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { cluster, databaseLink, freePort, nodeLink, sha, sleep, token, until } from "./cluster-helpers.ts";

// Production's lease (renewed every 3 s, fresh for 6 s, suspected at 9 s), and a periodic sweep too slow to matter.
export const PROD = { AGENT_LEASE_TTL_MS: "90000", AGENT_ORPHAN_SWEEP_MS: "600000" };

export type Served = { node: string; prompt: string; started: number; ended?: number; cut?: boolean };

/**
 * An OpenAI-compatible model that logs each call with the node that made it (each node has its own key for the
 * tenant, see `env`), when it started, and when it ended (`cut` when the caller closed it first). The prompt "stream"
 * answers slowly, a chunk every 200 ms for 40 s, the first time; "loop" asks for js_exec looking up keys one by one.
 */
export async function servingModel(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "agent-fresh-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const served: Served[] = [];
  const answered = new Set<string>();
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const node = String(req.headers.authorization).replace(/^Bearer fixture-key-/, "");
    const user = body.messages.find((message: any) => message.role === "user");
    const prompt = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
    const kind = prompt.includes("stream") ? "stream" : prompt.includes("loop") ? "loop" : "other";
    const entry: Served = { node, prompt: kind, started: Date.now() };
    served.push(entry);
    res.on("close", () => { entry.ended ??= Date.now(); if (!res.writableFinished) entry.cut = true; });
    const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const finished = body.messages.some((message: any) => message.role === "tool");
    if (kind === "stream" && !answered.has("stream")) {
      answered.add("stream");
      for (let index = 0; index < 200 && !res.destroyed; index++) { chunk({ role: "assistant", content: `w${index} ` }); await sleep(200); }
    } else if (kind === "loop" && !finished && !answered.has("loop")) {
      answered.add("loop");
      const code = "for (let i = 0; i < 160; i++) await tools.lookup({ key: String(i) }); return 'looped';";
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_loop", type: "function", function: { name: "js_exec", arguments: JSON.stringify({ code, timeoutMs: 60_000 }) } }] });
      chunk({}, "tool_calls");
      return res.end("data: [DONE]\n\n");
    } else chunk({ role: "assistant", content: `answered by ${node}` });
    if (!res.destroyed) { chunk({}, "stop"); res.end("data: [DONE]\n\n"); }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = (server.address() as { port: number }).port;
  // An agent keeps its model's URL wherever it moves; the tenant's key is the serving node's.
  const env = (node: string) => {
    const tenants = join(root, `${node}.json`);
    writeFileSync(tenants, JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: `fixture-key-${node}` } } } }));
    return { AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: `http://127.0.0.1:${port}/v1`, AGENT_TENANTS_FILE: tenants };
  };
  return { served, env };
}

/** The tool code calls: each lookup takes 250 ms, and is logged with when it started. */
export function slowLookup(calls: { key: string; at: number }[]) {
  return {
    lookup: tool({
      description: "Look up a value", input: schema.Object({ key: schema.String() }, { additionalProperties: false }),
      execute: async ({ key }) => { calls.push({ key, at: Date.now() }); await sleep(250); return `value-of-${key}`; },
    }),
  };
}

/** Two agents on `url`: one in a js_exec loop of tool calls, one waiting on a slow model stream. */
export async function busyAgents(t: { after(fn: () => Promise<void> | void): void }, url: string, calls: { key: string; at: number }[], served: Served[]) {
  const runtime = new AgentRuntime({ url, apiKey: token });
  const looping = await runtime.createAgent({ tools: slowLookup(calls), idempotencyKey: "looping" });
  const streaming = await runtime.createAgent({ tools: {}, idempotencyKey: "streaming" });
  t.after(async () => { await looping.close().catch(() => {}); await streaming.close().catch(() => {}); });
  const runs = [looping.prompt("loop", { idempotencyKey: "loop-turn", timeoutMs: 120_000 }), streaming.prompt("stream", { idempotencyKey: "stream-turn", timeoutMs: 120_000 })];
  for (const run of runs) run.catch(() => {});
  await until(() => calls.length >= 3 && served.some(entry => entry.prompt === "stream"), "both agents to be making effects");
  return { looping, streaming, runs };
}
