#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clock = () => performance.now();
const safeError = error => ({ name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 1000) });
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
export function distribution(values) {
  return { count: values.length, min: values.length ? Math.min(...values) : null, p50: percentile(values, .5), p95: percentile(values, .95), max: values.length ? Math.max(...values) : null };
}
export function serverOverlap(turns) {
  const intervals = turns.filter(turn => Number.isFinite(turn.serverTiming?.began) && Number.isFinite(turn.serverTiming?.endedAt));
  const edges = intervals.flatMap(turn => [[turn.serverTiming.began, 1], [turn.serverTiming.endedAt, -1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, max = 0;
  for (const [, change] of edges) { active += change; max = Math.max(max, active); }
  return { maxSimultaneousGenerations: max, observedIntervals: intervals.length,
    note: "Computed from server began/endedAt timestamps; absent timestamps are excluded." };
}

export class BenchmarkClient {
  constructor(baseUrl, token, runId = `agent-${Date.now()}-${randomUUID().slice(0, 8)}`) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.runId = runId;
  }
  async raw(path, options = {}) {
    const { auth = true, ...init } = options;
    return fetch(`${this.baseUrl}${path}`, {
      ...init, signal: init.signal ?? AbortSignal.timeout(90_000),
      headers: { ...(auth ? { authorization: `Bearer ${this.token}` } : {}), ...init.headers },
    });
  }
  async json(path, options = {}) {
    const response = await this.raw(path, options);
    const text = await response.text();
    if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path}: HTTP ${response.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  }
  async post(path, body, options = {}) {
    return this.json(path, { ...options, method: "POST", headers: { "content-type": "application/json", ...options.headers }, body: JSON.stringify(body) });
  }
  prefix(mode) { return mode === "deterministic" ? "/bench/deterministic" : ""; }
  async create(mode, key, extra = {}) {
    const started = clock();
    const response = await this.post(`${this.prefix(mode)}/v1/agents`, {
      fileTools: false, codeMode: false, thinkingLevel: "off", ...extra,
    }, { headers: { "Idempotency-Key": `${this.runId}-${key}` } });
    // The server's scoped credential is deliberately never retained in reports.
    return { id: response.id, mode, provisionMs: clock() - started };
  }
  async submit(agent, id, text) {
    return this.post(`${this.prefix(agent.mode)}/clients/${agent.id}/requests`, { id, method: "prompt", params: { text, history: "none" } });
  }
  async wait(agent, id, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = await this.json(`${this.prefix(agent.mode)}/clients/${agent.id}/requests/${id}?wait=10`);
      if (record.state === "completed") return record;
      await sleep(30);
    }
    throw new Error(`Request ${id} did not complete before ${timeoutMs}ms`);
  }
  async turn(agent, id, text) {
    const start = clock();
    const accepted = await this.submit(agent, id, text);
    const acceptedMs = clock() - start;
    const completed = await this.wait(agent, id);
    const result = { id, acceptedMs, totalMs: clock() - start, accepted: accepted.accepted === true,
      status: completed.status, reply: completed.outcome?.result?.reply, error: completed.error ?? completed.outcome?.error,
      serverTiming: { startedAt: completed.startedAt, began: completed.began, endedAt: completed.endedAt } };
    assert.equal(result.status, "completed", JSON.stringify(result));
    return result;
  }
  async diagnostics(agent) { return this.json(`/bench/${agent.mode === "deterministic" ? "deterministic" : "real"}/agents/${agent.id}/diagnostics`); }
  async inputs(agent) { return this.json(`${this.prefix(agent.mode)}/clients/${agent.id}/inputs`); }
  async read(agent, file) {
    const response = await this.raw(`${this.prefix(agent.mode)}/clients/${agent.id}/files/${file}`);
    if (!response.ok) throw new Error(`File read failed: ${response.status}`);
    return response.text();
  }
  async write(agent, file, value) {
    return this.json(`${this.prefix(agent.mode)}/clients/${agent.id}/files/${file}`, { method: "PUT", body: value });
  }
  async sseTurn(agent, id, text) {
    const controller = new AbortController();
    const response = await this.raw(`${this.prefix(agent.mode)}/clients/${agent.id}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", ready;
    const readiness = new Promise(resolve => { ready = resolve; });
    const frames = [], textParts = [], textDeltas = [];
    let firstTextMs = null, started;
    const reading = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end < 0) break;
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (frame.includes("event: ready")) ready();
            const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const event = JSON.parse(data);
            if (event.requestId !== id && event.id !== id) continue;
            frames.push(event.type === "event" ? event.event?.type : event.type);
            const delta = event.event?.assistantMessageEvent;
            if (delta?.type === "text_delta") {
              firstTextMs ??= clock() - started;
              textParts.push(delta.delta);
              textDeltas.push({ atMs: clock() - started, characters: delta.delta.length });
            }
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
    })();
    try {
      await Promise.race([readiness, sleep(10_000).then(() => { throw new Error("SSE ready timeout"); })]);
      started = clock();
      const result = await this.turn(agent, id, text);
      // The durable completion and network reader finish in separate tasks.
      for (let attempt = 0; attempt < 100 && !frames.includes("response"); attempt++) await sleep(10);
      assert.ok(textParts.length > 0, "No SSE text deltas observed");
      assert.equal(textParts.join(""), result.reply);
      return { ...result, firstTextMs, frames, textDeltas, streamedText: textParts.join("") };
    } finally { controller.abort(); await reader.cancel().catch(() => {}); await reading; }
  }
}

async function measure(client, options) {
  const before = await client.json("/bench/meta");
  const auth = [];
  for (const path of ["/healthz", "/bench/meta", "/unknown", "/bench/deterministic/agents/nope/diagnostics"]) {
    const response = await client.raw(path, { auth: false });
    auth.push({ path, status: response.status });
    assert.equal(response.status, 401, `Unauthenticated route: ${path}`);
  }
  const report = { schema: 1, kind: "agent-cloud-benchmark", runId: client.runId, baseUrl: client.baseUrl, at: new Date().toISOString(), before, auth };
  if (options.realTurns) {
    const agent = await client.create("real", "real", { systemPrompt: "Reply with the requested short text. Do not use tools." });
    const turns = [];
    for (let index = 0; index < options.realTurns; index++) {
      const runTurn = index === options.realTurns - 1 ? client.sseTurn.bind(client) : client.turn.bind(client);
      turns.push(await runTurn(agent, `real-${index}`, `Reply with exactly BENCH_OK_${index}.`));
    }
    const history = await client.json(`/clients/${agent.id}/history`);
    report.real = { agent, turns, totalMs: distribution(turns.map(turn => turn.totalMs)), diagnostics: await client.diagnostics(agent),
      modelMessages: history.messages.filter(message => message.role === "assistant").map(message => ({ model: message.model, provider: message.provider, stopReason: message.stopReason, usage: message.usage })) };
    if (options.out) await writeFile(options.out, `${JSON.stringify({ ...report, stage: "real-complete" }, null, 2)}\n`, { mode: 0o600 });
  }
  const createdAt = clock();
  const agents = await Promise.all(Array.from({ length: options.agents }, (_, index) => client.create("deterministic", `load-${index}`)));
  const provisionMs = clock() - createdAt;
  const diagnosticsBefore = await Promise.all(agents.map(agent => client.diagnostics(agent)));
  const start = clock();
  const settled = await Promise.allSettled(agents.map((agent, index) => client.turn(agent, `load-${index}`, `slow:1500:concurrent-${index}`)));
  const elapsedMs = clock() - start;
  const turns = settled.map((result, index) => result.status === "fulfilled" ? { agentId: agents[index].id, ...result.value } : { agentId: agents[index].id, failure: safeError(result.reason) });
  const failed = turns.filter(turn => turn.failure);
  const successful = turns.filter(turn => !turn.failure);
  for (const [index, result] of settled.entries()) if (result.status === "fulfilled") assert.equal(result.value.reply, `Echo: concurrent-${index}`);
  if (options.out) await writeFile(options.out, `${JSON.stringify({ ...report, stage: "concurrency-complete", deterministicConcurrency: {
    count: agents.length, elapsedMs, failedCount: failed.length, turns, overlap: serverOverlap(successful),
  } }, null, 2)}\n`, { mode: 0o600 });
  const sseAgent = agents[0];
  const sse = await client.sseTurn(sseAgent, "sse-deterministic", "stream-check");
  report.deterministic = { label: "100 independent agent DOs with deterministic model, not 100 real model calls", concurrency: agents.length,
    provisionMs, provisionLatencyMs: distribution(agents.map(agent => agent.provisionMs)), elapsedMs,
    completeCount: successful.length, failedCount: failed.length, turns, totalMs: distribution(successful.map(turn => turn.totalMs)), overlap: serverOverlap(successful),
    distinctConstructedInstances: new Set(diagnosticsBefore.map(item => item.instanceId)).size, sse,
    diagnosticsAfter: await Promise.all(agents.map(agent => client.diagnostics(agent))) };
  report.after = await client.json("/bench/meta");
  report.realDispatchesInThisRun = report.after.budget.reservedDispatches - before.budget.reservedDispatches;
  report.limits = ["Deterministic concurrency exercises the agent, storage, journal, directory, and transport; it does not measure model capacity.",
    "Client latency includes network and I/O. In-object fetch timing is wall time, not active CPU.",
    "Diagnostics do not measure heap. Cloud CPU and heap require separate platform/inspector observations.",
    "Reservations are an upper bound on dispatched binding calls and include failed or retried attempts; never more than 24 in this namespace."];
  assert.equal(failed.length, 0, `${failed.length} deterministic turns failed`);
  return report;
}

async function prepareReplay(client) {
  const before = await client.json("/bench/meta");
  const agent = await client.create("deterministic", "replay", { codeMode: true, fileTools: true });
  const code = `const marker = JSON.stringify({time:Date.now(),random:Math.random()});
    await tools.write({path:"/workspace/journal-marker.txt",content:marker});
    const seen = await tools.read({path:"/workspace/journal-marker.txt"});
    const answer = await tools.ask_human({question:marker});
    await tools.write({path:"/workspace/journal-result.txt",content:JSON.stringify({marker,seen,answer})});
    text(answer);`;
  await client.submit(agent, "replay-first", `code:${code}`);
  let inputs = [];
  for (let attempt = 0; attempt < 240 && !inputs.length; attempt++) { inputs = await client.inputs(agent); if (!inputs.length) await sleep(250); }
  assert.equal(inputs.length, 1, "Expected one durable human-input request");
  const queued = await client.submit(agent, "replay-queued", "queued-after-deploy");
  assert.equal(queued.accepted, true);
  const overwritten = "host changed after completed nested write";
  await client.write(agent, "journal-marker.txt", overwritten);
  return { schema: 1, kind: "replay-prepared", runId: client.runId, baseUrl: client.baseUrl, at: new Date().toISOString(),
    agent, before, beforeDiagnostics: await client.diagnostics(agent), inputs, overwritten, queued };
}

async function resumeReplay(client, state) {
  assert.equal(state.kind, "replay-prepared");
  assert.equal(state.baseUrl, client.baseUrl);
  const beforeAnswer = await client.diagnostics(state.agent);
  assert.notEqual(beforeAnswer.instanceId, state.beforeDiagnostics.instanceId, "Agent was not reconstructed; deploy or restart the worker before resuming");
  const inputs = await client.inputs(state.agent);
  assert.deepEqual(inputs, state.inputs, "Pending input changed across reconstruction");
  const answer = "approved after reconstruction";
  const path = `${client.prefix(state.agent.mode)}/experimental/agents/${state.agent.id}/inputs/${inputs[0].id}`;
  await client.post(path, { answer });
  const first = await client.wait(state.agent, "replay-first"), queued = await client.wait(state.agent, "replay-queued");
  assert.equal(first.status, "completed");
  assert.equal(queued.status, "completed");
  assert.equal(queued.outcome.result.reply, "Echo: queued-after-deploy");
  const markerAfter = await client.read(state.agent, "journal-marker.txt");
  assert.equal(markerAfter, state.overwritten, "Completed nested write was replayed");
  const output = JSON.parse(await client.read(state.agent, "journal-result.txt"));
  assert.equal(output.marker, inputs[0].question, "Clock or random marker diverged");
  assert.ok(JSON.stringify(output.seen).includes(String(JSON.parse(output.marker).random)), "Completed read result diverged");
  assert.equal(output.answer, answer);
  assert.deepEqual(await client.inputs(state.agent), []);
  return { schema: 1, kind: "replay-completed", runId: state.runId, baseUrl: client.baseUrl, at: new Date().toISOString(),
    agent: state.agent, before: state.before, beforeDiagnostics: state.beforeDiagnostics, afterDiagnostics: beforeAnswer,
    reconstructed: true, preservedPendingInput: true, preservedQueuedRequest: true, preservedClockRandomAndRead: true,
    completedWriteNotReplayed: true, first, queued, output, after: await client.json("/bench/meta"),
    limit: "Proves this deterministic tool/journal recovery case; not arbitrary external-effect exactly-once behavior." };
}

function args(argv) {
  const options = { command: argv.shift() ?? "measure", baseUrl: process.env.CAMELRUN_BENCH_URL, realTurns: 3, agents: 100 };
  while (argv.length) {
    const flag = argv.shift(), value = argv.shift();
    if (!value || !["--base-url", "--out", "--state", "--real-turns", "--agents", "--token-file"].includes(flag)) throw new Error(`Unknown or incomplete option: ${flag}`);
    options[{ "--base-url": "baseUrl", "--out": "out", "--state": "state", "--real-turns": "realTurns", "--agents": "agents", "--token-file": "tokenFile" }[flag]] = ["--real-turns", "--agents"].includes(flag) ? Number(value) : value;
  }
  assert.ok(options.baseUrl, "Use --base-url or CAMELRUN_BENCH_URL");
  assert.ok(Number.isInteger(options.realTurns) && options.realTurns >= 0 && options.realTurns <= 10, "--real-turns must be 0..10");
  assert.ok(Number.isInteger(options.agents) && options.agents >= 1 && options.agents <= 100, "--agents must be 1..100");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = args(argv);
  const token = options.tokenFile ? (await readFile(options.tokenFile, "utf8")).trim() : process.env.CAMELRUN_BENCH_API_TOKEN;
  assert.ok(token?.length >= 32, "Use --token-file or set CAMELRUN_BENCH_API_TOKEN; never pass the token value as an argument");
  const client = new BenchmarkClient(options.baseUrl, token);
  let report;
  if (options.command === "measure") report = await measure(client, options);
  else if (options.command === "replay-prepare") report = await prepareReplay(client);
  else if (options.command === "replay-resume") {
    assert.ok(options.state, "Use --state with the replay preparation report");
    report = await resumeReplay(client, JSON.parse(await readFile(options.state, "utf8")));
  } else throw new Error("Command must be measure, replay-prepare, or replay-resume");
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) await writeFile(options.out, output, { mode: 0o600 });
  else process.stdout.write(output);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ failed: true, error: safeError(error) })}\n`);
  process.exitCode = 1;
});
