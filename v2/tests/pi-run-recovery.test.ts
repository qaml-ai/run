import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { WorkerdStructuredLog } from "miniflare";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";
import { buildAgentWsUrl } from "../sdk/src/tools.ts";
import type { AgentEvent } from "../sdk/src/types.ts";
import type { AgentEventRecord, StoredMessage } from "../worker/src/types.ts";

const ADMIN_SECRET = "test-admin-secret-recovery";
const PRIOR_TURNS = 192;
const OLD_TEXT = "OLD_TURN_REPLY";
const OLD_CALL_ID = "call_old_turn";
const TOOL_NAME = "recovery_receipt";
const REPLY_PREFIX = "New answer for ";

interface RecoveryState {
  pausedAt: "before-sync" | "after-sync" | null;
  wakeups: number;
  subscribers: number;
  syncReads: Array<{ query: string; rowsRead: number }>;
  history: { count: number; tail: number };
  run: { status: string; baseline_entry_id: number | null } | null;
}

function priorHistory(): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (let i = 0; i < PRIOR_TURNS; i++) {
    const runId = `old_run_${i}`;
    const callId = `${OLD_CALL_ID}_${i}`;
    const push = (role: StoredMessage["role"], content: StoredMessage["content"]) => {
      const seq = messages.length + 1;
      messages.push({ seq, runId, role, content, createdAt: 1_700_000_000_000 + seq, tokensEst: 10 });
    };
    push("user", { text: `Old request ${i}` });
    push("assistant", { toolCalls: [{
      id: callId, name: TOOL_NAME, args: { turn: runId }, argumentsJson: JSON.stringify({ turn: runId }),
    }] });
    push("tool", { text: "Old receipt", toolCallId: callId, toolName: TOOL_NAME });
    push("assistant", { text: `${OLD_TEXT}_${i}` });
  }
  return messages;
}

async function eventually(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  do {
    if (await check()) return;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(description);
}

function openEventSocket(t: TestContext, url: string, events: AgentEventRecord[]) {
  const ws = new globalThis.WebSocket(url);
  t.after(() => ws.close());
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String((event as MessageEvent).data)) as {
      type: string;
      seq: number;
      runId: string | null;
      event: Pick<AgentEventRecord, "type" | "data" | "createdAt">;
    };
    if (frame.type === "event") events.push({ seq: frame.seq, runId: frame.runId, ...frame.event });
  });
  return ws;
}

function eventData(event: AgentEventRecord | AgentEvent): Record<string, unknown> {
  return (event.data ?? {}) as Record<string, unknown>;
}

function assertNoOldTurn(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes(OLD_TEXT), "previous assistant text leaked into the recovered run");
  assert.ok(!serialized.includes(OLD_CALL_ID), "a previous tool call leaked into the recovered run");
}

function assertOneTerminal(events: Array<AgentEvent | AgentEventRecord>, runId: string, expected = "run_completed") {
  const terminal = events.filter((event) => ["run_completed", "run_failed", "run_cancelled"].includes(event.type));
  assert.deepEqual(terminal.map(({ runId, type }) => ({ runId, type })), [{ runId, type: expected }]);
}

test("AgentDO isolates runs from old entries across repeated recovery", { timeout: 60_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "camelrun-pi-run-recovery-"));
  const config = join(directory, "wrangler.json");
  const warnings: string[] = [];
  const missingBoundaryWarnings = (agentId: string, runId: string) => warnings.filter((warning) =>
    warning.includes("run_recovery_boundary_missing") && warning.includes(runId) && warning.includes(agentId));
  const pendingAnswers = new Map<string, { attempts: number; finish?: () => void; released: boolean }>();
  const toolExecutions: string[] = [];
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (req.url === "/tool") {
      toolExecutions.push(body.args.turn);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ receipt: body.args.turn }));
      return;
    }
    const messages = body.messages as Array<{ role: string; content: string; tool_call_id?: string }>;
    const last = messages.at(-1);
    const turn = messages.findLast((message) => message.role === "user")?.content;
    const answer = turn && pendingAnswers.get(turn);
    if (!turn || !answer || (last?.role !== "user" && last?.role !== "tool")) {
      res.writeHead(400);
      res.end("Expected a test turn prompt or its tool response");
      return;
    }
    const toolCallId = `call_new_${turn}`;
    const send = (delta: object, finishReason: "stop" | "tool_calls" | null) => {
      sendProviderChunk(res, body.model, delta, finishReason);
    };
    if (last.role === "user") {
      send({ role: "assistant", tool_calls: [{
        index: 0, id: toolCallId, type: "function",
        function: { name: TOOL_NAME, arguments: JSON.stringify({ turn }) },
      }] }, "tool_calls");
      return;
    }
    if (last.tool_call_id !== toolCallId) {
      res.writeHead(400);
      res.end("Expected only the current turn's tool ID");
      return;
    }
    answer.attempts += 1;
    send({ role: "assistant", content: REPLY_PREFIX }, null);
    const finish = () => send({ content: turn }, "stop");
    if (answer.released) finish();
    else answer.finish = finish;
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const providerUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => {
    provider.closeAllConnections();
    provider.close();
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(config, JSON.stringify({
    name: "camelrun-pi-run-recovery-test",
    main: fileURLToPath(new URL("./fixtures/pi-run-recovery-worker.ts", import.meta.url)),
    compatibility_date: "2026-03-24",
    compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
    vars: {
      ADMIN_SECRET,
      VAULT_SECRET: "test-vault-secret-32-bytes-minimum!!",
      DEFAULT_MODEL: "mock/default",
    },
    durable_objects: {
      bindings: [
        { name: "TENANT_DO", class_name: "TenantDO" },
        { name: "AGENT_DO", class_name: "AgentDO" },
        { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO", "VoiceCallDO"] }],
  }));
  const worker = await unstable_startWorker({
    config,
    dev: {
      persist: false,
      logLevel: "none",
      structuredLogsHandler: (log: WorkerdStructuredLog) => { if (log.level === "warn") warnings.push(log.message); },
    },
  });
  t.after(() => worker.dispose());
  const baseUrl = (await worker.url).origin;
  const { apiKey } = await CamelRun.createTenant({ baseUrl, adminKey: ADMIN_SECRET, name: "Pi recovery" });
  const camel = new CamelRun({ baseUrl, apiKey });
  t.after(() => camel.close());
  await camel.providers.set("openrouter", { apiKey: "fixture-provider-key", baseUrl: `${providerUrl}/v1` });

  async function prepare(name: string) {
    const turn = `CURRENT_${name}`;
    const answer = { attempts: 0, finish: undefined as (() => void) | undefined, released: false };
    pendingAnswers.set(turn, answer);
    const agent = await camel.agents.upsert(name, {
      model: "openrouter/openai/gpt-4o-mini",
      builtins: [],
      tools: [{
        name: TOOL_NAME,
        description: "Record the test execution",
        parameters: { type: "object", properties: { turn: { type: "string" } }, required: ["turn"] },
        url: `${providerUrl}/tool`,
      }],
    });
    const importResponse = await fetch(`${baseUrl}/v2/agents/${agent.id}/import-history`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: priorHistory() }),
    });
    assert.equal(importResponse.status, 200, (await importResponse.text()).slice(0, 1000));
    const fixture = async (action: string, options?: { runId?: string; pauseAt?: string }) => {
      const url = new URL(`/test-recovery/${agent.id}/${action}`, baseUrl);
      for (const [key, value] of Object.entries(options ?? {})) url.searchParams.set(key, value);
      return fetch(url, { signal: AbortSignal.timeout(8_000) });
    };
    const control = async (action: string, options?: { runId?: string; pauseAt?: string }) => {
      const response = await fixture(action, options);
      assert.equal(response.status, 204, (await response.text()).slice(0, 1000));
    };
    const state = async (runId?: string): Promise<RecoveryState> => {
      const response = await fixture("state", runId ? { runId } : undefined);
      assert.equal(response.status, 200);
      return response.json() as Promise<RecoveryState>;
    };
    const oldHistory = (await state()).history;
    assert.ok(oldHistory.count >= PRIOR_TURNS * 4);
    const previousMessages = async () => {
      const first = await agent.history({ limit: 500 });
      const rest = await agent.history({ after: first.at(-1)!.seq, limit: 500 });
      return [...first, ...rest].filter((entry) => entry.seq! <= oldHistory.tail);
    };
    const start = async () => {
      const queued = await agent.submit(turn);
      await eventually(() => answer.attempts === 1, "provider did not receive the committed tool response");
      const running = (await state(queued.id)).run;
      assert.equal(running?.status, "running");
      assert.equal(running?.baseline_entry_id, oldHistory.tail);
      return queued.id;
    };
    const waitForCompleted = async (runId: string) => {
      await eventually(async () => ["completed", "failed", "cancelled"].includes((await state(runId)).run?.status ?? ""),
        "recovered run did not reach a terminal status");
      const record = await agent.getRun(runId);
      assert.equal(record.status, "completed", JSON.stringify(record.error));
      assert.equal(record.text, REPLY_PREFIX + turn);
      assertNoOldTurn(record);
      assert.deepEqual(toolExecutions.filter((execution) => execution === turn), [turn]);
      return record;
    };
    const wake = async () => {
      const priorWakeups = (await state()).wakeups;
      await control("wake");
      await eventually(async () => (await state()).wakeups > priorWakeups, "AgentDO alarm did not wake");
    };
    return {
      agent, start, state, control, oldHistory, previousMessages, waitForCompleted, wake,
      wsUrl: buildAgentWsUrl(baseUrl, agent.id, apiKey),
      toolCallId: `call_new_${turn}`,
      finalText: REPLY_PREFIX + turn,
      attempts: () => answer.attempts,
      finish: () => { answer.released = true; answer.finish?.(); },
    };
  }

  await t.test("WebSocket reconnects twice while the run is active", async (t) => {
    const fixture = await prepare("reconnect");
    const frames: AgentEventRecord[] = [];
    let socket = openEventSocket(t, fixture.wsUrl, frames);
    await eventually(() => socket.readyState === 1, "initial WebSocket did not open");
    const runId = await fixture.start();
    await eventually(() => frames.some((event) => event.type === "tool_call_end"), "initial socket did not see the tool complete");
    const streamedText = () => frames.filter((frame) => frame.type === "text_delta").map((frame) => eventData(frame).delta).join("");
    await eventually(() => streamedText() === REPLY_PREFIX, "initial socket did not see the interrupted answer prefix");
    for (let attempt = 2; attempt <= 3; attempt++) {
      await fixture.control("reset");
      await eventually(() => socket.readyState === 3, "isolate reset did not disconnect the WebSocket");
      socket = openEventSocket(t, fixture.wsUrl, frames);
      await eventually(() => socket.readyState === 1, "WebSocket did not reconnect");
      await eventually(() => fixture.attempts() === attempt, "reconnected run did not resume generation");
    }

    fixture.finish();
    const record = await fixture.waitForCompleted(runId);
    await eventually(() => frames.some((event) => event.type === "run_completed"), "reconnected socket did not see the terminal event");
    assertNoOldTurn(frames);
    assert.ok(frames.every((event) => event.runId === runId), "an event from another run reached the WebSocket");
    for (const type of ["tool_call_start", "tool_call_end"]) {
      assert.deepEqual(frames.filter((frame) => frame.type === type).map((frame) => eventData(frame).callId), [fixture.toolCallId]);
    }
    assert.equal(streamedText(), fixture.finalText);
    assertOneTerminal(frames, runId);
    assert.ok(frames.every((frame, index) => index === 0 || frame.seq > frames[index - 1]!.seq),
      "WebSocket event sequences were reused after reconnection");
    assert.deepEqual(record.toolCalls.map((call) => call.id), [fixture.toolCallId]);
    await fixture.control("reset");
    await fixture.wake();
    assertOneTerminal(await fixture.agent.events({ runId }), runId);
    assert.deepEqual(await fixture.agent.getRun(runId), record);
  });

  await t.test("headless recovery and a reset between sync and the terminal write", async () => {
    const fixture = await prepare("headless");
    const runId = await fixture.start();
    await fixture.control("reset");
    await fixture.control("instrument", { pauseAt: "after-sync" });
    await fixture.wake();
    await eventually(() => fixture.attempts() === 2, "the alarm did not resume headless generation");
    fixture.finish();
    await eventually(async () => (await fixture.state()).pausedAt === "after-sync", "settlement did not reach the commit barrier");
    const beforeReset = await fixture.state(runId);
    assert.equal(beforeReset.subscribers, 0);
    assert.equal(beforeReset.run?.status, "running");
    assert.ok(beforeReset.syncReads.length > 0, "the settlement read probe recorded no SQL");
    const rowsRead = beforeReset.syncReads.reduce((total, read) => total + read.rowsRead, 0);
    assert.ok(rowsRead > 0 && rowsRead < beforeReset.history.count - fixture.oldHistory.count + 16, JSON.stringify(beforeReset.syncReads));

    const before = await fixture.agent.events({ runId });
    await fixture.control("reset");
    await fixture.wake();
    const record = await fixture.waitForCompleted(runId);
    const events = [...before.filter((event) => event.type !== "run_started"), ...await fixture.agent.events({ runId })];
    assertNoOldTurn(events);
    for (const type of ["tool_call_start", "tool_call_end"]) {
      assert.deepEqual(events.filter((event) => event.type === type).map((event) => eventData(event).callId), [fixture.toolCallId]);
    }
    assert.equal(events.filter((event) => event.type === "text_delta").map((event) => eventData(event).delta).join(""), fixture.finalText);
    assertOneTerminal(events, runId);
    assert.deepEqual(record.toolCalls.map((call) => call.id), [fixture.toolCallId]);
    await fixture.control("reset");
    await fixture.wake();
    assertOneTerminal(await fixture.agent.events({ runId }), runId);
    assert.deepEqual(await fixture.agent.getRun(runId), record);
  });

  await t.test("legacy running row without a provable boundary preserves history and settles from its receipt", async () => {
    const fixture = await prepare("legacy");
    const oldMessages = await fixture.previousMessages();
    assert.equal(oldMessages.length, PRIOR_TURNS * 4);
    await fixture.control("instrument", { pauseAt: "before-sync" });
    const runId = await fixture.start();
    fixture.finish();
    await eventually(async () => (await fixture.state()).pausedAt === "before-sync", "Pi did not produce a settled receipt");
    await fixture.control("legacy", { runId });
    assert.equal((await fixture.state(runId)).run?.baseline_entry_id, null);
    const settledHistory = (await fixture.state()).history;
    await fixture.control("reset");
    await fixture.control("instrument");
    await fixture.wake();
    const record = await fixture.waitForCompleted(runId);
    assert.equal(record.text, fixture.finalText);
    assert.deepEqual(record.toolCalls, []);
    await eventually(() => missingBoundaryWarnings(fixture.agent.id, runId).length === 1,
      "missing boundary was not observable in structured warnings");
    const events = await fixture.agent.events({ runId });
    assertNoOldTurn(events);
    assertOneTerminal(events, runId);
    assert.deepEqual(events.map((event) => event.type), ["run_started", "run_completed"]);
    const afterRecovery = await fixture.state(runId);
    assert.deepEqual(afterRecovery.syncReads, []);
    assert.deepEqual(afterRecovery.history, settledHistory);
    assert.deepEqual(await fixture.previousMessages(), oldMessages);
    const tail = await fixture.agent.history({ after: fixture.oldHistory.tail });
    assert.ok(JSON.stringify(tail).includes(fixture.toolCallId), "legacy fallback deleted current tool entries");
    assert.ok(JSON.stringify(tail).includes(fixture.finalText), "legacy fallback deleted the answer from history");
    await fixture.control("reset");
    await fixture.wake();
    assertOneTerminal(await fixture.agent.events({ runId }), runId);
    assert.deepEqual(await fixture.agent.getRun(runId), record);
    assert.equal(missingBoundaryWarnings(fixture.agent.id, runId).length, 1);
  });

  await t.test("orphan legacy row without a Pi receipt fails once and leaves history intact", async () => {
    const fixture = await prepare("orphan");
    const oldMessages = await fixture.previousMessages();
    const observedTools = [...toolExecutions];
    const runId = "run_orphaned_legacy";
    await fixture.control("orphan", { runId });
    assert.deepEqual((await fixture.state(runId)).run, { status: "running", baseline_entry_id: null });
    await fixture.control("reset");
    await fixture.wake();
    await eventually(async () => (await fixture.state(runId)).run?.status === "failed", "orphaned run did not settle");
    await eventually(() => missingBoundaryWarnings(fixture.agent.id, runId).length === 1,
      "orphaned run did not log the missing boundary");
    const record = await fixture.agent.getRun(runId);
    assert.equal(record.status, "failed");
    assert.equal(typeof record.error === "object" ? record.error?.code : null, "not_found");
    assert.equal(record.text, "");
    assert.deepEqual(record.toolCalls, []);
    assertNoOldTurn(record);
    await fixture.control("reset");
    await fixture.wake();
    const events = await fixture.agent.events({ runId });
    assertOneTerminal(events, runId, "run_failed");
    assert.equal(events.length, 1);
    assertNoOldTurn(events);
    assert.equal(missingBoundaryWarnings(fixture.agent.id, runId).length, 1);
    assert.deepEqual(await fixture.agent.getRun(runId), record);
    assert.deepEqual((await fixture.state()).history, fixture.oldHistory);
    assert.deepEqual(await fixture.previousMessages(), oldMessages);
    assert.deepEqual(toolExecutions, observedTools);
  });
});

function sendProviderChunk(res: ServerResponse, model: string, delta: object, finishReason: "stop" | "tool_calls" | null) {
  if (res.destroyed) return;
  const chunk = {
    id: "chatcmpl-recovery",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason !== null ? { usage: { prompt_tokens: 12, completion_tokens: 8 } } : {}),
  };
  if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (finishReason !== null) res.end("data: [DONE]\n\n");
}
