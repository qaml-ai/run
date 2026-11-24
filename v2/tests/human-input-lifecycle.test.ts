import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun, CamelRunError, defineTool } from "../sdk/src/index.ts";

const ADMIN_SECRET = "test-admin-secret-input-lifecycle";
const VAULT_SECRET = "test-vault-secret-32-bytes-minimum!!";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe("human input lifecycle: supersede, abort, expiry, and multi-actor isolation", () => {
  let tempDir: string;
  let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
  let workerUrl: string;
  let providerServer: Server;
  let providerUrl: string;
  let providerRequests: Array<Array<{ role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }>> = [];

  before(async () => {
    providerRequests = [];
    providerServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }>;
      };
      providerRequests.push(body.messages);
      const last = body.messages.at(-1);
      const promptText = typeof last?.content === "string" ? last.content : "";

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (promptText.includes("REQUEST_ASK_HUMAN")) {
        const chunk = {
          id: "chatcmpl-ask",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_provider_ask_1",
                    type: "function",
                    function: { name: "ask_human", arguments: JSON.stringify({ question: "Proceed with deploy?" }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
        return;
      }

      const chunk = {
        id: "chatcmpl-reply",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: `Handled: ${promptText}` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      };
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    const addr = providerServer.address();
    assert.ok(addr && typeof addr === "object");
    providerUrl = `http://127.0.0.1:${addr.port}`;

    tempDir = mkdtempSync(join(tmpdir(), "camelrun-input-lifecycle-"));
    const configPath = join(tempDir, "wrangler.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        name: "camelrun-input-lifecycle-test",
        main: fileURLToPath(new URL("./fixtures/alarm-worker.ts", import.meta.url)),
        compatibility_date: "2026-03-24",
        compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
        vars: {
          ADMIN_SECRET,
          VAULT_SECRET,
          CAMELFS_URL: "http://127.0.0.1:9",
          DEFAULT_MODEL: "mock/default",
        },
        durable_objects: {
          bindings: [
            { name: "TENANT_DO", class_name: "TenantDO" },
            { name: "AGENT_DO", class_name: "AgentDO" },
            { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
          ],
        },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
          { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
        ],
      }),
    );

    const workerPort = await getFreePort();
    worker = await unstable_startWorker({
      config: configPath,
      dev: {
        persist: false,
        server: { hostname: "127.0.0.1", port: workerPort },
        logLevel: "none",
      },
    });
    workerUrl = `http://127.0.0.1:${workerPort}`;
    const healthDeadline = Date.now() + 10_000;
    while (Date.now() < healthDeadline) {
      try {
        const res = await fetch(`${workerUrl}/healthz`);
        if (res.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(async () => {
    await worker?.dispose();
    providerServer?.closeAllConnections();
    providerServer?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  function eventData(ev: { data?: unknown }): Record<string, unknown> {
    return (ev.data ?? {}) as Record<string, unknown>;
  }

  async function waitForRunStatus(
    agent: Awaited<ReturnType<CamelRun["agents"]["upsert"]>>,
    runId: string,
    expected: string,
    timeoutMs = 8_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    let rec = await agent.getRun(runId);
    while (rec.status !== expected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
      rec = await agent.getRun(runId);
    }
    return rec;
  }

  it("a. new run supersedes pending approval and ask_human inputs, appends tool result, emits events, and pairs provider history", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "supersede-tenant",
      initialCreditsUsd: 10,
    });
    const camel = new CamelRun({
      baseUrl: workerUrl,
      apiKey,
      WebSocket: globalThis.WebSocket as unknown as NonNullable<ConstructorParameters<typeof CamelRun>[0]["WebSocket"]>,
    });

    try {
      // 1. Approval tool superseded by a new user message
      let refunded = false;
      const refundTool = defineTool({
        name: "issueRefund",
        description: "Issue refund",
        parameters: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
        requiresApproval: true,
        execute: async ({ amount }: { amount: number }) => {
          refunded = true;
          return { refunded: amount };
        },
      });
      const approvalAgent = await camel.agents.upsert("supersede-approval", {
        model: "mock/default",
        tools: [refundTool],
        builtins: ["human"],
      });

      const pausedApproval = await approvalAgent.run(`Refund [CALL:issueRefund {"amount":50}]`);
      assert.equal(pausedApproval.status, "input_required");
      assert.equal(pausedApproval.inputs.length, 1);
      const approvalInput = pausedApproval.inputs[0]!;

      const nextApprovalRun = await approvalAgent.run("Never mind, just check the balance instead");
      assert.equal(nextApprovalRun.status, "completed");
      assert.equal(refunded, false);

      const closedApproval = await approvalAgent.getRun(pausedApproval.id);
      assert.equal(closedApproval.status, "cancelled");
      assert.equal(closedApproval.inputs[0]?.status, "superseded");

      const approvalHistory = await approvalAgent.history({ limit: 50 });
      const supersededToolMsg = approvalHistory.find(
        (m) => m.runId === pausedApproval.id && m.role === "tool",
      );
      assert.ok(supersededToolMsg, "Expected synthetic tool message for superseded approval");
      const content = supersededToolMsg.content as Record<string, unknown>;
      assert.equal(content.toolCallId, approvalInput.toolCallId);
      assert.equal(content.toolName, "issueRefund");
      assert.equal(content.isError, true);
      assert.equal(content.text, "<harness>\n[error] Tool issueRefund was aborted\n</harness>");

      const approvalEvents = await approvalAgent.events({ runId: pausedApproval.id });
      const toolEnd = approvalEvents.find((e) => e.type === "tool_call_end");
      assert.ok(toolEnd);
      assert.equal(eventData(toolEnd).callId, approvalInput.toolCallId);
      assert.equal(eventData(toolEnd).name, "issueRefund");
      assert.equal(eventData(toolEnd).ok, false);
      assert.equal(eventData(toolEnd).error, "Not answered: the user sent a new message instead (next).");

      const inputResolved = approvalEvents.find((e) => e.type === "input_resolved");
      assert.ok(inputResolved);
      assert.equal(eventData(inputResolved).id, approvalInput.id);
      assert.equal(eventData(inputResolved).status, "superseded");

      assert.ok(approvalEvents.some((e) => e.type === "run_cancelled"));
      assert.equal(approvalEvents.some((e) => e.type === "run_failed"), false);

      await assert.rejects(
        approvalAgent.answerInput(approvalInput.id, { approved: true }),
        (err) => err instanceof CamelRunError && err.code === "input_already_resolved",
      );

      // 2. Question (ask_human) superseded with real OpenAI-chat provider verifying paired tool_call + tool result
      await camel.providers.set("openrouter", { apiKey: "fake-key", baseUrl: `${providerUrl}/v1` });
      const questionAgent = await camel.agents.upsert("supersede-question", {
        model: "openrouter/openai/gpt-4o-mini",
        builtins: ["human"],
      });

      const pausedQuestion = await questionAgent.run("REQUEST_ASK_HUMAN");
      assert.equal(pausedQuestion.status, "input_required");
      assert.equal(pausedQuestion.inputs.length, 1);
      const qInput = pausedQuestion.inputs[0]!;

      const nextQuestionRun = await questionAgent.run("Skip deploy and summarize status");
      assert.equal(nextQuestionRun.status, "completed");
      assert.match(nextQuestionRun.text, /Skip deploy and summarize status/);

      const closedQuestion = await questionAgent.getRun(pausedQuestion.id);
      assert.equal(closedQuestion.status, "cancelled");
      assert.equal(closedQuestion.inputs[0]?.status, "superseded");

      const lastReqMessages = providerRequests.at(-1)!;
      const assistantCallIdx = lastReqMessages.findIndex(
        (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
      );
      assert.ok(assistantCallIdx >= 0, "Provider should receive the paused assistant tool_call");
      const pairedToolMsg = lastReqMessages[assistantCallIdx + 1];
      assert.equal(pairedToolMsg?.role, "tool");
      assert.equal(pairedToolMsg?.tool_call_id, qInput.toolCallId);
      assert.equal(pairedToolMsg?.content, "<harness>\n[error] Tool ask_human was aborted\n</harness>");
      assert.equal(lastReqMessages.at(-1)?.role, "user");
    } finally {
      await camel.close();
    }
  });

  it("b. supersedeInputs: false and scheduled runs stay queued behind input_required", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "optout-tenant",
      initialCreditsUsd: 10,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });

    try {
      const agent = await camel.agents.upsert("optout-agent", {
        model: "mock/default",
        builtins: ["human"],
      });

      const paused = await agent.run(`Need choice [CALL:ask_human {"question":"Option A or B?"}]`);
      assert.equal(paused.status, "input_required");
      const inputId = paused.inputs[0]!.id;

      // Explicit opt-out stays queued
      const queued = await agent.submit("Background manager notice", { supersedeInputs: false });
      assert.equal(queued.status, "queued");

      // Schedule firing via alarm must also pass supersedeInputs: false and not dismiss the input
      const sched = await agent.schedules.create({
        prompt: "Scheduled heartbeat",
        intervalSeconds: 1,
      });
      await new Promise((r) => setTimeout(r, 1500));
      await agent.schedules.delete(sched.id);

      const stillPaused = await agent.getRun(paused.id);
      assert.equal(stillPaused.status, "input_required");
      assert.equal(stillPaused.inputs[0]?.status, "pending");
      assert.equal((await agent.getRun(queued.id)).status, "queued");

      // Answering resumes paused turn and drains queued turns
      const answered = await agent.answerInput(inputId, { answer: "Option A" });
      assert.equal(answered.status, "completed");

      const drained = await waitForRunStatus(agent, queued.id, "completed");
      assert.equal(drained.status, "completed");
    } finally {
      await camel.close();
    }
  });

  it("c. abortRuns closes input_required (with supersedeInputs+keepQueued draining queue, and default cancelling all)", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "abort-input-tenant",
      initialCreditsUsd: 10,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });

    try {
      // Case 1: abortRuns({ keepQueued: true, supersedeInputs: true }) unblocks and drains queued turns immediately
      const agent1 = await camel.agents.upsert("abort-keep-queued", {
        model: "mock/default",
        builtins: ["human"],
      });
      const paused1 = await agent1.run(`Hold [CALL:ask_human {"question":"Proceed?"}]`);
      assert.equal(paused1.status, "input_required");
      const inp1 = paused1.inputs[0]!;

      const queued1 = await agent1.submit("Queued user message waiting on stuck approval", {
        supersedeInputs: false,
      });
      assert.equal(queued1.status, "queued");

      const abortRes1 = await agent1.abort({ keepQueued: true, supersedeInputs: true });
      assert.equal(abortRes1.aborted, true);
      assert.deepEqual(abortRes1.cancelledRunIds, [paused1.id]);

      const closed1 = await agent1.getRun(paused1.id);
      assert.equal(closed1.status, "cancelled");
      assert.equal(closed1.inputs[0]?.status, "superseded");

      const history1 = await agent1.history({ limit: 50 });
      const toolMsg1 = history1.find((m) => m.runId === paused1.id && m.role === "tool");
      assert.ok(toolMsg1);
      assert.equal((toolMsg1.content as Record<string, unknown>).text, "<harness>\n[error] Tool ask_human was aborted\n</harness>");

      const events1 = await agent1.events({ runId: paused1.id });
      assert.ok(events1.some((e) => e.type === "input_resolved" && eventData(e).id === inp1.id && eventData(e).status === "superseded"));
      assert.ok(events1.some((e) => e.type === "run_cancelled"));

      const drained1 = await waitForRunStatus(agent1, queued1.id, "completed");
      assert.equal(drained1.status, "completed");

      // Case 2: default abortRuns() cancels input_required + queued runs with application cancellation text
      const agent2 = await camel.agents.upsert("abort-cancel-all", {
        model: "mock/default",
        builtins: ["human"],
      });
      const paused2 = await agent2.run(`Hold [CALL:ask_human {"question":"Confirm?"}]`);
      assert.equal(paused2.status, "input_required");
      const inp2 = paused2.inputs[0]!;

      const queued2 = await agent2.submit("Queued work", { supersedeInputs: false });
      assert.equal(queued2.status, "queued");

      const abortRes2 = await agent2.abort();
      assert.equal(abortRes2.aborted, true);
      const cancelledIds = abortRes2.cancelledRunIds as string[];
      assert.ok(cancelledIds.includes(paused2.id));
      assert.ok(cancelledIds.includes(queued2.id));

      const closed2 = await agent2.getRun(paused2.id);
      assert.equal(closed2.status, "cancelled");
      assert.equal(closed2.inputs[0]?.status, "cancelled");
      assert.equal((await agent2.getRun(queued2.id)).status, "cancelled");

      const history2 = await agent2.history({ limit: 50 });
      const toolMsg2 = history2.find((m) => m.runId === paused2.id && m.role === "tool");
      assert.ok(toolMsg2);
      const content2 = toolMsg2.content as Record<string, unknown>;
      assert.equal(content2.toolCallId, inp2.toolCallId);
      assert.equal(content2.toolName, "ask_human");
      assert.equal(content2.isError, true);
      assert.equal(content2.text, "<harness>\n[error] Tool ask_human was aborted\n</harness>");

      const events2 = await agent2.events({ runId: paused2.id });
      assert.ok(events2.some((e) => e.type === "tool_call_end" && eventData(e).callId === inp2.toolCallId && eventData(e).ok === false));
      assert.ok(events2.some((e) => e.type === "input_resolved" && eventData(e).id === inp2.id && eventData(e).status === "cancelled"));
      assert.ok(events2.some((e) => e.type === "run_cancelled"));
    } finally {
      await camel.close();
    }
  });

  it("d. alarm() expiry appends expired tool result, emits tool_call_end + input_resolved (expired), and drains queue", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "expiry-tenant",
      initialCreditsUsd: 10,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });

    try {
      const agent = await camel.agents.upsert("expiry-agent", {
        model: "mock/default",
        builtins: ["human"],
      });

      const paused = await agent.run(`Wait [CALL:ask_human {"question":"Still there?"}]`);
      assert.equal(paused.status, "input_required");
      const inp = paused.inputs[0]!;

      const queued = await agent.submit("Run after expiry", { supersedeInputs: false });
      assert.equal(queued.status, "queued");

      const control = `${workerUrl}/test-alarm/${agent.id}`;
      assert.equal((await fetch(control, { method: "POST" })).status, 204);

      const drained = await waitForRunStatus(agent, queued.id, "completed");
      assert.equal(drained.status, "completed");

      const expiredRun = await agent.getRun(paused.id);
      assert.equal(expiredRun.status, "failed");
      assert.equal(expiredRun.inputs[0]?.status, "expired");
      assert.equal(
        typeof expiredRun.error === "object" ? expiredRun.error?.code : undefined,
        "input_expired",
      );

      const history = await agent.history({ limit: 50 });
      const toolMsg = history.find((m) => m.runId === paused.id && m.role === "tool");
      assert.ok(toolMsg, "Expected synthetic tool message on input expiry");
      const content = toolMsg.content as Record<string, unknown>;
      assert.equal(content.toolCallId, inp.toolCallId);
      assert.equal(content.toolName, "ask_human");
      assert.equal(content.isError, true);
      assert.equal(content.text, "<harness>\n[error] Tool ask_human was aborted\n</harness>");

      const events = await agent.events({ runId: paused.id });
      const toolEnd = events.find((e) => e.type === "tool_call_end");
      assert.ok(toolEnd);
      assert.equal(eventData(toolEnd).callId, inp.toolCallId);
      assert.equal(eventData(toolEnd).name, "ask_human");
      assert.equal(eventData(toolEnd).ok, false);
      assert.equal(eventData(toolEnd).error, "Not answered: the request for input expired.");

      const inputResolved = events.find((e) => e.type === "input_resolved");
      assert.ok(inputResolved);
      assert.equal(eventData(inputResolved).id, inp.id);
      assert.equal(eventData(inputResolved).status, "expired");

      assert.ok(events.some((e) => e.type === "run_failed"));
    } finally {
      await camel.close();
    }
  });

  it("e. multi-actor isolation: Actor B does not supersede Actor A, while same actor or undefined actor does", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "multi-actor-tenant",
      initialCreditsUsd: 10,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });

    try {
      const agent = await camel.agents.upsert("multi-actor-agent", {
        model: "mock/default",
        builtins: ["human"],
      });

      // Actor A pauses for input
      const pausedA1 = await agent.run(`Ask A [CALL:ask_human {"question":"A confirm?"}]`, {
        actor: "user_a",
      });
      assert.equal(pausedA1.status, "input_required");

      // Actor B submits a message: must NOT supersede Actor A's pending input
      const runB = await agent.submit("Hello from user B", { actor: "user_b" });
      assert.equal(runB.status, "queued");
      assert.equal((await agent.getRun(pausedA1.id)).status, "input_required");
      assert.equal((await agent.getRun(pausedA1.id)).inputs[0]?.status, "pending");

      // Actor A sends a new message: DOES supersede Actor A's own pending input, unblocking the queue
      const runA2 = await agent.run("Actually never mind from user A", { actor: "user_a" });
      assert.equal(runA2.status, "completed");
      assert.equal((await agent.getRun(pausedA1.id)).status, "cancelled");
      assert.equal((await agent.getRun(pausedA1.id)).inputs[0]?.status, "superseded");
      assert.equal((await waitForRunStatus(agent, runB.id, "completed")).status, "completed");

      // Now Actor A pauses again, and an unscoped run (actor: undefined) DOES supersede it
      const pausedA2 = await agent.run(`Ask A again [CALL:ask_human {"question":"A confirm 2?"}]`, {
        actor: "user_a",
      });
      assert.equal(pausedA2.status, "input_required");

      const unscopedRun = await agent.run("System override message");
      assert.equal(unscopedRun.status, "completed");
      assert.equal((await agent.getRun(pausedA2.id)).status, "cancelled");
      assert.equal((await agent.getRun(pausedA2.id)).inputs[0]?.status, "superseded");
    } finally {
      await camel.close();
    }
  });
});
