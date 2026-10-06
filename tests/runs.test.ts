import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Agents, RunError } from "../clients/node.ts";
import { OPERATOR, OTHER_OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const userMessages = (body: any) => body.messages.filter((message: any) => message.role === "user");
const session = (runId: string) => `client_${runId.slice("run_".length)}`;

/** Read a run's event stream: each frame's id and data, until it ends, or `stop` says to cut it off. */
async function frames(base: string, runId: string, options: { lastEventId?: number; stop?: (frame: { id: number; data: any }) => boolean } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/runs/${runId}/events`, { headers: { Authorization: `Bearer ${OPERATOR}`, ...(options.lastEventId ? { "Last-Event-ID": String(options.lastEventId) } : {}) }, signal: controller.signal });
  assert.equal(response.status, 200, await (response.ok ? "" : response.text()));
  const got: { id: number; data: any }[] = [];
  let buffer = "";
  try {
    for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\n\n")) !== -1; buffer = buffer.slice(end + 2)) {
        const lines = buffer.slice(0, end).split("\n");
        const id = Number(lines.find(line => line.startsWith("id:"))?.slice(3));
        const text = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!text || lines.includes("event: ready") || !Number.isSafeInteger(id)) continue;
        const frame = { id, data: JSON.parse(text) };
        got.push(frame);
        if (options.stop?.(frame)) { controller.abort(); return got; }
      }
    }
  } catch (error) { if (!controller.signal.aborted) throw error; }
  return got;
}

test("a stateless run takes its configuration and input and answers with its result, in one call; it is no agent", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "yes", usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  const created = await r.call("/v1/runs", { body: { input: "Should we ship?", systemPrompt: "You vote yes or no.", metadata: { voter: "7" }, wait: true } });
  assert.equal(created.status, 200, created.text);
  const run = created.json;
  assert.match(run.id, /^run_[a-f0-9]{40}$/);
  assert.equal(run.status, "completed");
  assert.equal(run.text, "yes");
  assert.equal(run.error, null);
  assert.deepEqual(run.metadata, { voter: "7" });
  assert.equal(run.usage.responses, 1);
  assert.equal(run.usage.input, 10);
  assert.ok(run.expiresAt > run.endedAt + 86_000_000, "kept a day by default");
  assert.match(r.model.bodies[0].messages[0].content, /You vote yes or no/);
  // Read again: the same run, as it ended.
  assert.deepEqual((await r.call(`/v1/runs/${run.id}`)).json, run);
  // Its messages: the input and the answer.
  const messages = (await r.call(`/v1/runs/${run.id}/messages`)).json.messages;
  assert.deepEqual(messages.map((message: any) => message.role), ["user", "assistant"]);
  // Not an agent: not listed, not reachable as one, and its session's id is no way in.
  assert.deepEqual((await r.call("/v1/agents")).json, []);
  assert.equal((await r.call(`/v1/agents/${session(run.id)}`)).status, 404);
  assert.equal((await r.call(`/v1/agents/${session(run.id)}/history`)).status, 404);
  assert.equal((await r.call(`/v1/agents/${session(run.id)}/credentials`)).status, 404, "it has no token to give");
  await r.call(`/v1/agents/${session(run.id)}`, { method: "DELETE" });
  assert.equal((await r.call(`/v1/runs/${run.id}`)).json.status, "completed", "the agents API cannot delete it");
  // It made no volume, and its session's agent stopped as it ended.
  assert.equal((await r.db.query("select count(*)::int as n from volumes")).rows[0].n, 0);
  assert.deepEqual((await r.db.query("select header->'mounts' as mounts from agents where id = $1", [session(run.id)])).rows[0].mounts, []);
  // Another tenant does not see it.
  assert.equal((await r.call(`/v1/runs/${run.id}`, { token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call("/v1/runs/run_nope")).status, 404);
});

test("without wait a run answers 202 at once; GET with wait has it end", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "later", delayMs: 600 }));
  const created = await r.call("/v1/runs", { body: { input: "Take your time" } });
  assert.equal(created.status, 202, created.text);
  assert.equal(created.json.status, "running");
  assert.equal(created.json.expiresAt, null);
  const ended = await r.call(`/v1/runs/${created.json.id}?wait=10`);
  assert.equal(ended.json.status, "completed");
  assert.equal(ended.json.text, "later");
});

test("two runs with the same configuration share nothing: each model call has only its own input", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `vote on: ${userMessages(body).map((message: any) => typeof message.content === "string" ? message.content : message.content[0].text).join("|")}` }));
  const config = { systemPrompt: "Vote.", thinkingLevel: "off", wait: true };
  const first = (await r.call("/v1/runs", { body: { ...config, input: "question one" } })).json;
  const second = (await r.call("/v1/runs", { body: { ...config, input: "question two" } })).json;
  assert.notEqual(first.id, second.id);
  assert.equal(first.text, "vote on: question one");
  assert.equal(second.text, "vote on: question two");
  assert.equal(r.model.bodies.length, 2);
  for (const body of r.model.bodies) assert.equal(userMessages(body).length, 1);
});

test("a run with output answers with an object that fits its schema", async t => {
  const schema = { type: "object", properties: { vote: { type: "string", enum: ["yes", "no"] }, confidence: { type: "number" } }, required: ["vote", "confidence"], additionalProperties: false };
  const r = await runtime(t, () => toolCall("final_output", { vote: "no", confidence: 0.75 }));
  const run = (await r.call("/v1/runs", { body: { input: "Ship on Friday?", output: { schema }, wait: true } })).json;
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.deepEqual(run.output, { vote: "no", confidence: 0.75 });
  assert.deepEqual(r.model.bodies[0].tools.find((tool: any) => tool.function.name === "final_output").function.parameters, schema);
});

test("an Idempotency-Key names one run: again with the same body it is that run, with another body a 409", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "once" }));
  const body = { input: "count me once", wait: true };
  const first = await r.call("/v1/runs", { body, headers: { "Idempotency-Key": "vote-42" } });
  const again = await r.call("/v1/runs", { body: { ...body, wait: 5 }, headers: { "Idempotency-Key": "vote-42" } });
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, first.json);
  assert.equal(r.model.bodies.length, 1, "the model was asked once");
  const conflict = await r.call("/v1/runs", { body: { ...body, input: "something else" }, headers: { "Idempotency-Key": "vote-42" } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "IDEMPOTENCY_CONFLICT");
  // Two at once with one key: one run.
  const [a, b] = await Promise.all([1, 2].map(() => r.call("/v1/runs", { body: { input: "concurrent", wait: true }, headers: { "Idempotency-Key": "vote-43" } })));
  assert.equal(a.json.id, b.json.id);
  assert.equal(r.model.bodies.length, 2);
  // Another tenant's same key is its own run.
  const other = await r.call("/v1/runs", { body, headers: { "Idempotency-Key": "vote-42" }, token: OTHER_OPERATOR });
  assert.notEqual(other.json.id, first.json.id);
});

test("abort ends a running run as failed, code aborted", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "too late", delayMs: 20_000 }));
  const created = (await r.call("/v1/runs", { body: { input: "think hard" } })).json;
  await until(() => r.model.bodies.length === 1, "the model call");
  assert.equal((await r.call(`/v1/runs/${created.id}/abort`, { method: "POST" })).json.aborted, true);
  const ended = (await r.call(`/v1/runs/${created.id}?wait=10`)).json;
  assert.equal(ended.status, "failed", JSON.stringify(ended));
  assert.equal(ended.error.code, "aborted", JSON.stringify(ended));
});

test("runs count against busy agents and runs per minute, as agent runs do, and not against agent creates", async t => {
  const tenants = { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, maxAgents: 1, maxRunsPerMinute: 3, maxAgentCreatesPerMinute: 1 },
  } };
  // One runtime whose model answers slowly, to keep a run busy; another whose model answers at once.
  const r = await runtime(t, () => ({ role: "assistant", content: "done" }), {}, tenants);
  const slow = await runtime(t, () => ({ role: "assistant", content: "slow", delayMs: 3_000 }), {}, tenants);
  const busy = (await slow.call("/v1/runs", { body: { input: "hold the slot" } })).json;
  assert.equal(busy.status, "running");
  const refused = await slow.call("/v1/runs", { body: { input: "one too many" } });
  assert.equal(refused.status, 429, refused.text);
  assert.equal(refused.json.code, "BUSY_AGENT_LIMIT");
  // A refused run leaves nothing behind.
  assert.equal((await slow.db.query("select count(*)::int as n from agents where not revoked")).rows[0].n, 1);
  assert.equal((await slow.call(`/v1/runs/${busy.id}?wait=10`)).json.status, "completed");
  // Three runs a minute (each a run), though one agent create a minute: creates are not counted. The minute is a fixed
  // window, so one may end among the runs: at most twice three get through.
  let started = 0, limited;
  while (started <= 6 && (limited = await r.call("/v1/runs", { body: { input: `vote ${started}`, wait: true } })).status === 200) started++;
  assert.ok(started >= 3 && started <= 6, `${started} runs started`);
  assert.equal(limited!.status, 429, limited!.text);
  assert.equal(limited!.json.limit.name, "runs");
  assert.equal((await r.call("/v1/agents", { body: {} })).status, 201, "the create budget is untouched");
});

test("a run's event stream follows it to its end, and picks up after Last-Event-ID without a gap or a repeat", async t => {
  const r = await runtime(t, (_body, index) => index === 0 ? { ...toolCall("js_exec", { code: "return 6 * 7" }), delayMs: 300 } : { role: "assistant", content: "it is 42", delayMs: 800 });
  const created = (await r.call("/v1/runs", { body: { input: "compute" } })).json;
  // Read until the first tool call ends, then drop the connection.
  const head = await frames(r.base, created.id, { stop: frame => frame.data.event?.type === "tool_execution_end" });
  assert.ok(head.length > 0);
  const rest = await frames(r.base, created.id, { lastEventId: head.at(-1)!.id });
  const ids = [...head, ...rest].map(frame => frame.id).filter(id => id > (head[0].data.type === "snapshot" ? head[0].id : 0));
  assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b), "no repeats, in order");
  for (let i = 1; i < rest.length; i++) assert.equal(rest[i].id, rest[i - 1].id + 1, "no gap");
  assert.equal(rest[0].id, head.at(-1)!.id + 1, "it picks up right after");
  const last = rest.at(-1)!.data;
  assert.equal(last.type, "response");
  assert.equal(last.id, created.id);
  assert.equal(last.outcome.result.reply, "it is 42");
  // After it ended: the stream is its response, then it ends.
  const after = await frames(r.base, created.id);
  assert.equal(after.at(-1)!.data.type, "response");
  assert.equal(after.at(-1)!.data.outcome.result.reply, "it is 42");
});

test("an ended run is kept for its retention, then everything it stored is deleted", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "short-lived" }), { AGENT_RUN_RETENTION_SECONDS: "2", AGENT_IDLE_MS: "1000", AGENT_PURGE_INTERVAL_MS: "1000" });
  const run = (await r.call("/v1/runs", { body: { input: "remember nothing", wait: true } })).json;
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.ok(run.expiresAt - run.endedAt === 2_000);
  const id = session(run.id);
  assert.equal((await r.call(`/v1/runs/${run.id}`)).status, 200, "kept within its retention");
  const journal = join(r.root, "client-sessions", `${id}.journal`);
  await until(async () => (await r.db.query("select purged_at from agents where id = $1", [id])).rows[0]?.purged_at, "the purge", 30_000);
  assert.equal((await r.call(`/v1/runs/${run.id}`)).status, 404);
  assert.equal((await r.call(`/v1/runs/${run.id}/messages`)).status, 404);
  const row = (await r.db.query("select tenant, header from agents where id = $1", [id])).rows[0];
  assert.deepEqual(row, { tenant: "", header: { version: 3, id, revoked: true, purged: true } }, "only a tombstone");
  assert.equal(existsSync(journal), false);
  assert.equal(existsSync(join(r.root, "sessions", id)), false);
  for (const table of ["agent_history_index", "agent_spend_limits"]) {
    assert.equal((await r.db.query(`select count(*)::int as n from ${table} where agent = $1`, [id])).rows[0].n, 0, table);
  }
});

test("a run's configuration is checked before anything is made", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }));
  for (const [body, message] of [
    [{}, /input/],
    [{ input: "   " }, /some text/],
    [{ input: "x", builtins: ["ask_user"] }, /builtins/],
    [{ input: "x", mcp: { tools: [] } }, /mcp/],
    [{ input: "x", model: "nope/nope" }, /model/i],
    [{ input: "x", retentionSeconds: 5 }, /retentionSeconds/],
  ] as const) {
    const refused = await r.call("/v1/runs", { body });
    assert.equal(refused.status, 400, `${JSON.stringify(body)}: ${refused.text}`);
    assert.match(refused.json.error, message);
  }
  assert.equal((await r.db.query("select count(*)::int as n from agents where not revoked")).rows[0].n, 0);
  assert.equal(r.model.bodies.length, 0);
});

test("the TypeScript SDK: agents.run in one call, runs.stream as it happens, runs.get, abort and messages", async t => {
  const r = await runtime(t, body => /slow/.test(JSON.stringify(body.messages)) ? { role: "assistant", content: "never", delayMs: 8_000 }
    : /vote/.test(JSON.stringify(body.messages)) ? toolCall("final_output", { vote: "yes" }) : body.messages.some((message: any) => message.role === "tool") ? { role: "assistant", content: "two" } : toolCall("js_exec", { code: "return 1 + 1" }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  const voted = await agents.run({ instructions: "Vote.", input: "vote: ship it?", output: z.object({ vote: z.enum(["yes", "no"]) }), metadata: { voter: "1" } });
  assert.equal(voted.status, "completed");
  assert.deepEqual(voted.output, { vote: "yes" });
  assert.match(voted.id, /^run_/);
  const again = await agents.runs.get(voted.id);
  assert.deepEqual(again.output, { vote: "yes" });
  assert.deepEqual(again.metadata, { voter: "1" });
  assert.deepEqual((await agents.runs.messages(voted.id)).map(message => message.role), ["user", "assistant", "toolResult"]);

  const stream = await agents.runs.stream({ input: "add" });
  const parts = [];
  for await (const part of stream) parts.push(part);
  assert.deepEqual(parts.map(part => part.type), ["tool_call", "tool_result", "text", "done"]);
  const done = parts.at(-1) as { type: "done"; run: { text: string } };
  assert.equal(done.run.text, "two");
  assert.equal((await stream.result()).text, "two");

  const slow = await agents.runs.create({ input: "slow" });
  assert.equal(slow.status, "running");
  await until(() => r.model.bodies.some(body => /slow/.test(JSON.stringify(body.messages))), "the slow model call");
  await agents.runs.abort(slow.id);
  const aborted = await agents.runs.stream(slow.id, { throwOnError: false });
  const failed = await aborted.result();
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "aborted");
  await assert.rejects(agents.run({ input: "slow", idempotencyKey: "slow-2", signal: AbortSignal.timeout(500) }), /aborted|timeout/i);
  await agents.runs.abort((await agents.runs.create({ input: "slow", idempotencyKey: "slow-2" })).id);
  await assert.rejects(agents.runs.run({ input: "slow", idempotencyKey: "slow-2" }), (error: unknown) => error instanceof RunError && error.run.error?.code === "aborted");
  assert.deepEqual(await agents.runtime.listAgents(), [], "no agents were made");
});
