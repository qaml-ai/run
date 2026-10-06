import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { OPERATOR, runtime, sleep, toolCall, until, watchEvents, type T } from "./runtime-server.ts";
import { cluster, token as clusterToken } from "./cluster-helpers.ts";

const auth = { Authorization: `Bearer ${OPERATOR}` };
const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } } : {}) })}\n\n`;
const userTexts = (body: any) => body.messages.filter((message: any) => message.role === "user").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));

/**
 * An OpenAI-compatible provider: `respond` gives each request a delta to answer with, or "hang" (no answer, as a provider
 * whose stream dropped) or "keepalive" (headers, then only SSE comments, as OpenRouter sends while its upstream hangs).
 */
async function provider(t: T, respond: (body: any, index: number) => object | "hang" | "keepalive" | Promise<object | "hang" | "keepalive">) {
  const bodies: any[] = [];
  const timers = new Set<ReturnType<typeof setInterval>>();
  const held = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    bodies.push(body);
    const answer = await respond(body, bodies.length - 1);
    if (answer === "hang") { held.add(res); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (answer === "keepalive") {
      const timer = setInterval(() => res.write(": OPENROUTER PROCESSING\n\n"), 100);
      timers.add(timer);
      res.on("close", () => clearInterval(timer));
      return;
    }
    const { delayMs, ...delta } = answer as { delayMs?: number };
    if (delayMs) await sleep(delayMs);
    res.write(chunk(delta));
    res.write(chunk({}, (delta as { tool_calls?: unknown }).tool_calls ? "tool_calls" : "stop"));
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies };
}

type Runtime = Awaited<ReturnType<typeof runtime>>;
const record = async (r: Runtime, agent: string, id: string) => (await r.call(`/v1/agents/${agent}/requests/${id}`)).json;
const settled = (r: Runtime, agent: string, id: string, ms?: number) => until(async () => { const found = await record(r, agent, id); return found.state === "completed" && found; }, `${id} to settle`, ms);
const prompt = async (r: Runtime, agent: string, body: Record<string, unknown>) => {
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body });
  assert.equal(accepted.status, 202, accepted.text);
  return accepted.json;
};
/** Whether the agent is busy, as each view of it says: GET /v1/agents/{id}, its state, and a status request with its token. */
async function views(r: Runtime, agent: { id: string; token: string }) {
  const detail = (await r.call(`/v1/agents/${agent.id}`)).json;
  const state = (await r.call(`/v1/agents/${agent.id}/state`)).json;
  const status = await r.call(`/clients/${agent.id}/requests`, { token: agent.token, body: { id: `status-${Math.random().toString(36).slice(2)}`, method: "status", params: {} } });
  const outcome = (await until(async () => { const found = (await r.call(`/clients/${agent.id}/requests/${status.json.id}`, { token: agent.token })).json; return found.state === "completed" && found; }, "the status request")).outcome.result;
  return [detail, state, outcome].map(view => ({ busy: view.busy, activeRun: view.activeRun, queuedRuns: view.queuedRuns }));
}

test("a run past its agent's own maxSeconds is aborted inside a hung model request, and ends as its time limit's", { timeout: 60_000 }, async t => {
  const model = await provider(t, () => "hang");
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url, AGENT_RUN_OVERRUN_MS: "1000", AGENT_IDLE_MS: "2000" });
  // The stall timeouts (minutes, by default) are far off: only the run's time limit can end this turn.
  const { id } = (await r.call("/v1/agents", { body: { runLimits: { maxSeconds: 1 } } })).json;
  const started = Date.now();
  await prompt(r, id, { text: "go", requestId: "turn-1" });
  const done = await settled(r, id, "turn-1", 20_000);
  assert.ok(Date.now() - started < 15_000, `ended ${Date.now() - started} ms after it began`);
  assert.equal(done.stopped, "turn_limit");
  assert.equal(done.outcome.result.code, "turn_limit");
  assert.equal(done.outcome.result.error, "This run stopped at its time limit of 1 second. Send another message to continue");
  assert.equal(model.bodies.length, 1);
});

test("a stalled model is retried, watchers see the stall, and a model that never answers fails its run with model_stream_stalled", { timeout: 90_000 }, async t => {
  const model = await provider(t, (body, index) => userTexts(body).at(-1) === "once" && index > 0 ? { role: "assistant", content: "recovered" } : "keepalive");
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url, AGENT_MODEL_FIRST_TOKEN_SECONDS: "1", AGENT_MODEL_IDLE_SECONDS: "1" });
  const { id } = (await r.call("/v1/agents", { body: {} })).json;
  const watcher = await watchEvents(t, `${r.base}/v1/agents/${id}/events`, auth);
  await prompt(r, id, { text: "once", requestId: "turn-1" });
  const recovered = await settled(r, id, "turn-1");
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.outcome.result.reply, "recovered");
  assert.ok(watcher.frames.some(frame => frame.data.type === "event" && frame.data.requestId === "turn-1" && frame.data.event.type === "model_stream_stalled"));

  // Every attempt stalls: the run fails with a clear error, and the agent is idle for the next message.
  await prompt(r, id, { text: "never", requestId: "turn-2" });
  const failed = await settled(r, id, "turn-2", 60_000);
  assert.equal(failed.status, "failed");
  assert.equal(failed.outcome.result.code, "model_stream_stalled");
  assert.match(failed.error, /^Model stream stalled/);
  await until(() => watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === "turn-2"), "the failed run's response on the stream");
  assert.equal((await r.call(`/v1/agents/${id}`)).json.busy, false);
});

/** An agent whose first turn hangs in its model request (a stalled provider) until stopped, with runs queued behind it. */
async function stalledWithQueue(t: T) {
  const model = await provider(t, (body) => userTexts(body).at(-1).startsWith("hang") ? "hang" : { role: "assistant", content: `answer: ${userTexts(body).at(-1)}` });
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const agent = (await r.call("/v1/agents", { body: {} })).json as { id: string; token: string };
  const watcher = await watchEvents(t, `${r.base}/v1/agents/${agent.id}/events`, auth);
  await prompt(r, agent.id, { text: "hang 1", requestId: "turn-1" });
  await until(() => model.bodies.length === 1, "the turn's model request");
  await prompt(r, agent.id, { text: "queued 1", requestId: "q-1" });
  await prompt(r, agent.id, { text: "queued 2", requestId: "q-2" });
  const steer = await prompt(r, agent.id, { text: "steered", requestId: "s-1", whileRunning: "steer" });
  return { model, r, agent, watcher, steer };
}

test("stopping an agent ends its turn and cancels the runs queued behind it, so nothing runs after the stop; queued: keep stops the turn only", { timeout: 60_000 }, async t => {
  const { model, r, agent, watcher } = await stalledWithQueue(t);
  const stopped = await r.call(`/v1/agents/${agent.id}/abort`, { body: {} });
  assert.equal(stopped.status, 200, stopped.text);
  await settled(r, agent.id, "turn-1");
  await sleep(1_000);
  assert.equal(model.bodies.length, 1, "nothing ran after the stop");
  assert.deepEqual(stopped.json, { aborted: true, cancelled: ["q-1", "q-2", "s-1"] });
  assert.equal((await record(r, agent.id, "turn-1")).outcome.result.code, "aborted");
  for (const id of ["q-1", "q-2", "s-1"]) {
    const cancelled = await record(r, agent.id, id);
    assert.equal(cancelled.state, "completed");
    assert.equal(cancelled.status, "failed");
    assert.equal(cancelled.outcome.result.code, "cancelled");
    assert.ok(watcher.frames.some(frame => frame.data.type === "event" && frame.data.requestId === id && frame.data.event.type === "run_cancelled"), `${id}'s event`);
    assert.ok(watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === id), `${id}'s response`);
  }
  const history = (await r.call(`/v1/agents/${agent.id}/history`)).json.messages;
  assert.ok(!history.some((message: any) => ["q-1", "q-2", "s-1"].includes(message.requestId)), "no cancelled message reached the history");

  // A message after the stop runs as usual.
  await prompt(r, agent.id, { text: "after", requestId: "after-1" });
  assert.equal((await settled(r, agent.id, "after-1")).outcome.result.reply, "answer: after");

  // queued: "keep" stops the running turn only: the next queued run starts.
  await prompt(r, agent.id, { text: "hang 2", requestId: "turn-2" });
  await until(() => model.bodies.length === 3, "the second turn's model request");
  await prompt(r, agent.id, { text: "kept", requestId: "q-3" });
  assert.equal((await r.call(`/v1/agents/${agent.id}/abort`, { body: { queued: "nope" } })).status, 400);
  assert.deepEqual((await r.call(`/v1/agents/${agent.id}/abort`, { body: { queued: "keep" } })).json, { aborted: true, cancelled: [] });
  assert.equal((await settled(r, agent.id, "q-3")).outcome.result.reply, "answer: kept");
});

test("every view of an agent agrees whether it is busy: during a stall, and after a stop", { timeout: 60_000 }, async t => {
  const { r, agent, steer } = await stalledWithQueue(t);
  const during = await views(r, agent);
  assert.deepEqual(during[1], during[0], "its state says what GET /v1/agents/{id} says");
  assert.deepEqual(during[2], during[0], "a status request says it too");
  assert.deepEqual(during[0], { busy: true, activeRun: "turn-1", queuedRuns: 3 });
  await r.call(`/v1/agents/${agent.id}/abort`, { body: {} });
  await settled(r, agent.id, "turn-1");
  for (const view of await views(r, agent)) assert.deepEqual(view, { busy: false, activeRun: null, queuedRuns: 0 });
  assert.equal(steer.steer, "accepted", "the steer counted among the queued runs was accepted by the stalled turn");
});

test("a steer is acknowledged at once and completes when the running turn takes it: a turn fed steers forever never fills the queue", { timeout: 120_000 }, async t => {
  // The turn calls a tool at every step until a message says to stop, so it runs as long as messages keep coming.
  const model = await provider(t, (body, index) => userTexts(body).at(-1) === "stop now"
    ? { role: "assistant", content: `done after ${userTexts(body).length} messages` }
    : { ...toolCall("js_exec", { code: "return 1" }, `call_${index}`), delayMs: 50 });
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const { id } = (await r.call("/v1/agents", { body: {} })).json;
  const watcher = await watchEvents(t, `${r.base}/v1/agents/${id}/events`, auth);
  await prompt(r, id, { text: "go", requestId: "turn-1" });
  await until(() => model.bodies.length >= 1, "the turn to start");
  // More steers than the 32 requests an agent may have open: each completes as the turn takes it, so none waits for its end.
  for (let index = 1; index <= 40; index++) {
    const accepted = await prompt(r, id, { text: `note ${index}`, requestId: `s-${index}`, whileRunning: "steer" });
    const taken = await settled(r, id, `s-${index}`);
    assert.equal(accepted.steer, "accepted", `s-${index}`);
    assert.equal(taken.steeredInto, "turn-1");
    assert.equal(taken.status, "completed");
    assert.deepEqual(taken.outcome, { result: { steeredInto: "turn-1" } });
  }
  assert.equal((await record(r, id, "turn-1")).state, "running", "the turn is still going");
  assert.ok(watcher.frames.some(frame => frame.data.type === "event" && frame.data.requestId === "s-1" && frame.data.event.type === "steer_taken" && frame.data.event.steeredInto === "turn-1"));
  await prompt(r, id, { text: "stop now", requestId: "s-stop", whileRunning: "steer" });
  const turn = await settled(r, id, "turn-1");
  assert.equal(turn.outcome.result.reply, "done after 42 messages");
  // With no turn running, a steer starts one: queued.
  const idle = await prompt(r, id, { text: "stop now", requestId: "s-idle", whileRunning: "steer" });
  assert.equal(idle.steer, "queued");
  assert.equal((await settled(r, id, "s-idle")).steeredInto, undefined);
});

test("a run stopped before its node was lost is not resumed by the node that takes the agent over", { timeout: 90_000 }, async t => {
  if (process.env.AGENT_HOSTING === "inline") return t.skip("needs the agent in a process of its own, to freeze it");
  const c = await cluster(t);
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    bodies.push(JSON.parse(text));
    if (bodies.length === 1) return; // The first request hangs.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(chunk({ role: "assistant", content: "resumed" }));
    res.end(chunk({}, "stop") + "data: [DONE]\n\n");
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
  const a = await c.start("a", env);
  const b = await c.start("b", { ...env, AGENT_ORPHAN_SWEEP_MS: "500" });
  const call = (base: string, path: string, body?: unknown, bearer = clusterToken) => fetch(base + path, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(response => response.json() as Promise<any>);
  const agent = await call(a.url, "/v1/agents", {});
  await call(a.url, `/v1/agents/${agent.id}/prompt`, { text: "go", requestId: "turn-1" });
  await until(() => bodies.length === 1, "A's model request");
  await call(a.url, `/clients/${agent.id}/requests`, { id: "status-1", method: "status", params: {} }, agent.token);
  const pid = (await until(async () => (await call(a.url, `/clients/${agent.id}/requests/status-1`, undefined, agent.token)).outcome?.result?.pid, "the agent's pid")) as number;
  // The agent's process freezes: the stop is recorded, but its abort never reaches the turn before A dies.
  process.kill(pid, "SIGSTOP");
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  void call(a.url, `/v1/agents/${agent.id}/abort`, {}).catch(() => {});
  await sleep(1_000);
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const ended = await until(async () => {
    const found = (await call(b.url, `/v1/agents/${agent.id}/state`)).requests?.find((request: any) => request.id === "turn-1");
    return found?.state === "completed" && found;
  }, "B to settle the stopped run", 60_000);
  assert.equal(ended.outcome.result.code, "aborted");
  await sleep(1_000);
  assert.equal(bodies.length, 1, "the model was not asked again");
});
