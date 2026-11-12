import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";

// Workflows end to end in workerd: an agent writes a workflow with its `workflows` builtin, the workflow runs three
// keyed agent() children in parallel and a critic, every child a real agent the workflow owns (its ending delivered
// by the child's outbox), and the agent reports the result. Then a budget too small pauses a workflow, and a raise
// and a resume finish it. Every model call is the scripted provider below, priced so spend is real.

const textOf = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part: any) => part.text ?? "").join("\n");
const systemOf = (body: any) => body.messages.filter((message: any) => message.role === "system").map(textOf).join("\n");
const lastUser = (body: any) => textOf(body.messages.filter((message: any) => message.role === "user").at(-1));

function provider(respond: (body: any) => { content?: string; tool?: { name: string; args: unknown; id: string }; tokens?: number }) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const answer = respond(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (chunk: unknown) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    const base = { id: "wf-model", object: "chat.completion.chunk", created: 1, model: "wf-model" };
    const delta = answer.tool
      ? { role: "assistant", tool_calls: [{ index: 0, id: answer.tool.id, type: "function", function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.args) } }] }
      : { role: "assistant", content: answer.content ?? "" };
    send({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
    // Priced at $1,000/M input tokens (below): each token costs $0.001.
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: answer.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: answer.tokens ?? 1, completion_tokens: 0, total_tokens: answer.tokens ?? 1 } });
    response.end("data: [DONE]\n\n");
  });
  return { server, bodies };
}

async function until<T>(check: () => Promise<T | undefined | false>, description: string, timeout = 90_000, last?: () => Promise<unknown>): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}${last ? ` (last: ${JSON.stringify(await last())})` : ""}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

const SCRIPT = `
phase("review");
const reviews = await parallel(["a", "b", "c"], file => agent("REVIEW " + file, { key: "review:" + file, type: "worker" }));
phase("judge");
const verdict = await agent("CRITIC: check " + JSON.stringify(reviews), { key: "critic", type: "critic", output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } });
return { reviews, verdict, files: args.files };`;

const GATE_SCRIPT = `const go = await gate({ key: "go", question: "Ship it?", options: ["ship", "hold"], recommended: "ship", reason: "Reviews passed" }); return { go };`;

test("an agent starts a workflow of keyed workers and a critic, owned by the workflow, and reports its result; a spent budget pauses one until a raise", { timeout: 600_000 }, async t => {
  let workflowId: string | undefined, gatedWorkflowId: string | undefined, budgetWorkflowId: string | undefined;
  const model = provider(body => {
    const system = systemOf(body), user = lastUser(body), last = body.messages.at(-1);
    if (system.includes("You are a worker in a workflow")) return { content: `reviewed ${user.replace("REVIEW ", "")}` };
    if (system.includes("You are a critic in a workflow")) return { tool: { name: "final_output", args: { ok: true }, id: "verdict" } };
    if (user.includes("EXPENSIVE")) return { content: "costly answer", tokens: 600 };
    if (system.includes("You are a sub-agent")) return { content: `plain answer to ${user}` };
    // The orchestrating agent: start the workflow and end its turn; it never polls. Its workflow's ending comes as a
    // child's (workflow-endings.ts), a <workflow_notification> in a turn of its own: its line, then its facts as JSON.
    if (last.role === "tool" && user.includes("<workflow_notification")) return { content: "RAISED" };
    if (user.includes("<workflow_notification")) {
      const notices = [...user.matchAll(/<workflow_notification workflow="([A-Za-z0-9_-]+)"[^>]*status="([a-z_]+)">\n([^\n]*)\n([\s\S]*?)\n<\/workflow_notification>/g)];
      // A stop for its budget: raise it (workflow_budget), and the workflow goes on as the row's next attempt.
      const stopped = notices.find(notice => notice[2] === "paused");
      if (stopped) return { tool: { name: "workflow_budget", args: { workflowId: stopped[1], usd: 5 }, id: `raise-${stopped[1]}` } };
      const ending = notices.find(notice => notice[2] === "completed");
      return { content: ending ? `REPORT ${ending[4]}` : `NOTED ${notices.map(notice => notice[2]).join(",")}` };
    }
    if (user.includes("BUDGETED") && last.role === "tool") { budgetWorkflowId = JSON.parse(textOf(last)).workflowId; return { content: "started" }; }
    if (user.includes("BUDGETED")) return { tool: { name: "workflow_start", args: { script: `const a = await agent("EXPENSIVE one", { key: "one", class: "fast" }); const b = await agent("cheap two", { key: "two", class: "fast" }); return [a, b];`, budgetUsd: 0.5, concurrency: 1, name: "budgeted" }, id: "start-budgeted" } };
    if (user.includes("GATED") && last.role === "tool") { gatedWorkflowId = JSON.parse(textOf(last)).workflowId; return { content: "started" }; }
    if (user.includes("GATED")) return { tool: { name: "workflow_start", args: { script: GATE_SCRIPT, budgetUsd: 1, name: "gated" }, id: "start-gated" } };
    if (last.role === "tool") { workflowId = JSON.parse(textOf(last)).workflowId; return { content: "started" }; }
    return { tool: { name: "workflow_start", args: { script: SCRIPT, args: { files: 3 }, budgetUsd: 1, name: "review three" }, id: "start" } };
  });
  model.server.listen(0, "127.0.0.1"); await once(model.server, "listening");
  t.after(() => { model.server.closeAllConnections(); return new Promise<void>(resolve => model.server.close(() => resolve())); });
  // No AGENT_PUBLIC_URL, as on a local `wrangler dev`: children are configured with the origin the workflow was
  // started at (its owner agent's), and never started at all when they were not.
  const fixture = await startFixture({ noPublicUrl: true, vars: { TEST_MODEL: "0", MODEL: "openai/gpt-4o-mini", AGENT_WORKFLOW_CLASS_MODELS: JSON.stringify({ fast: "wf-fixture/wf-model", strong: "wf-fixture/wf-model", max: "wf-fixture/wf-model" }) } });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(fixture.url + path, { method, headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as any };
  };
  const ok = async (path: string, body?: unknown, method?: string) => {
    const { status, value } = await call(path, body, method);
    assert.ok(status >= 200 && status < 300, `${path}: ${status} ${JSON.stringify(value)}`);
    return value;
  };
  assert.equal((await call("/v1/providers/wf-fixture", { type: "openai-completions", baseUrl: `http://127.0.0.1:${(model.server.address() as { port: number }).port}/v1`, models: [{ id: "wf-model", contextWindow: 32768, pricing: { input: 1000, output: 0 } }] }, "PUT")).status, 200);

  // An agent that may delegate has the workflows builtin; it writes and runs one.
  const agent = await ok("/v1/agents", { model: "wf-fixture/wf-model", codeMode: false, fileTools: false, builtins: ["delegate"], delegate: { instructions: true } });
  const run = await ok(`/v1/agents/${agent.id}/prompt`, { text: "go" });
  const started = await until(async () => { const record = await ok(`/v1/agents/${agent.id}/requests/${run.id}`); return record.state === "completed" && record; }, "the agent's run");
  assert.equal(started.outcome?.result?.reply, "started");
  console.log(`E2E agent run done at ${new Date().toISOString()}`);
  // The ending reaches the agent as a <workflow_notification>: a turn of its own, in which it reports the result.
  const reportRun = await until(async () => {
    const requests = (await ok(`/v1/agents/${agent.id}`)).requests as { id: string; state: string; outcome?: { result?: { reply?: string } } }[];
    return requests.find(request => request.state === "completed" && String(request.outcome?.result?.reply ?? "").startsWith("REPORT ")) ?? false;
  }, "the agent's report from its notification");
  // The notification's request is the workflow child's first (and only) attempt's.
  assert.equal(reportRun.id, `child_${workflowId}_a000001`);
  const reply = String(reportRun.outcome!.result!.reply);
  const reported = JSON.parse(reply.slice("REPORT ".length));
  assert.equal(reported.status, "completed", reply);
  assert.deepEqual(reported.result, { reviews: ["reviewed a", "reviewed b", "reviewed c"], verdict: { ok: true }, files: 3 });
  // It never asked for the workflow's status: everything it knew came in its notification.
  const asked = model.bodies.flatMap(body => (body.messages as any[]).flatMap(message => (message.tool_calls ?? []).map((call: any) => call.function?.name)));
  assert.ok(!asked.includes("workflow_status"), JSON.stringify(asked));
  // The owner heard it once: one notification, no other turn of the workflow's.
  const notified = ((await ok(`/v1/agents/${agent.id}`)).requests as { id: string }[]).filter(request => request.id.startsWith(`child_${workflowId}`));
  assert.deepEqual(notified.map(request => request.id), [`child_${workflowId}_a000001`]);


  // The workflow, through the public API: completed, its four effects done, its spend in its ledger.
  const workflow = await ok(`/v1/workflows/${workflowId}`);
  assert.equal(workflow.status, "completed");
  assert.deepEqual(workflow.owner, { kind: "agent", id: agent.id });
  assert.equal(workflow.name, "review three");
  assert.ok(workflow.spent.usd > 0 && workflow.spent.usd <= 1, JSON.stringify(workflow.spent));
  const items = (await ok(`/v1/workflows/${workflowId}/items`)).items as { key: string; kind: string; status: string }[];
  assert.deepEqual(items.filter(item => item.kind === "agent").map(item => [item.key, item.status]).sort(), [["critic", "done"], ["review:a", "done"], ["review:b", "done"], ["review:c", "done"]]);
  // Each child is a real agent the workflow owns, placed under it.
  const children = (await fixture.db.query("select header->'owner' as owner, header->'rootOwner' as root, header->>'parentAgentId' as parent from agents where header->'config'->>'type' = 'subagent'")).rows;
  assert.equal(children.length, 4);
  for (const child of children) {
    assert.deepEqual(child.owner, { kind: "workflow", id: workflowId });
    assert.deepEqual(child.root, { kind: "workflow", id: workflowId });
  }
  // The children's usage rolls up into the agent that owns the workflow (the workflow stays their owner).
  const rolled = await until(async () => {
    const usage = await ok(`/v1/agents/${agent.id}/usage?rollup=true&groupBy=agent`);
    const rows = (usage.rows ?? usage.groups ?? usage.usage ?? []) as { agent?: string; responses?: number; usd?: number; costUsd?: number }[];
    const own = (await fixture.db.query("select count(*)::int as n from usage_details where root_agent = $1 and agent <> $1", [agent.id])).rows[0].n;
    return own >= 4 && { usage, own };
  }, "the children's usage in the owner's rollup", 60_000, async () => (await fixture.db.query("select agent, root_agent from usage_details")).rows);
  assert.ok(rolled.own >= 4, JSON.stringify(rolled));
  // An ended workflow is not aborted: a 409 the object answers as a refusal, not an error it throws.
  const late = await call(`/v1/workflows/${workflowId}/abort`, {});
  assert.equal(late.status, 409, JSON.stringify(late.value));
  assert.match(late.value.error, /completed workflow cannot be aborted/);
  // Another tenant's key does not find it; a workflow of no one is not found either.
  assert.equal((await call("/v1/workflows/wf_unknown")).status, 404);

  // A budget too small: the expensive first agent spends more than the whole budget, so the second is refused for
  // budget, and the workflow pauses instead of handing the script a null. A raise and a resume finish it.
  const small = await ok("/v1/workflows", { script: `const a = await agent("EXPENSIVE one", { key: "one", class: "fast" }); const b = await agent("cheap two", { key: "two", class: "fast" }); return [a, b];`, budget: { usd: 0.5 }, concurrency: 1 });
  assert.match(small.id, /^wf_/);
  const paused = await until(async () => { const value = await ok(`/v1/workflows/${small.id}`); return ["budget_exhausted", "paused"].includes(value.status) && value; }, "the budget pause", 90_000,
    async () => ({ workflow: await ok(`/v1/workflows/${small.id}`), items: await ok(`/v1/workflows/${small.id}/items?attempts=true`) }));
  assert.equal(paused.status, "budget_exhausted", JSON.stringify(paused));
  assert.ok(paused.spent.usd >= 0.5, JSON.stringify(paused.spent));
  // A raise above what it spent runs it again by itself: the refused effect is issued again under its next attempt.
  await ok(`/v1/workflows/${small.id}/budget`, { usd: 5 });
  const finished = await until(async () => { const value = await ok(`/v1/workflows/${small.id}`); return value.status === "completed" && value; }, "the resumed workflow", 90_000,
    async () => ({ workflow: await ok(`/v1/workflows/${small.id}`), items: await ok(`/v1/workflows/${small.id}/items`) }));
  assert.deepEqual(finished.result, ["costly answer", "plain answer to cheap two"]);

  // gate(): an agent's workflow asks a person in the account's inbox. The owner hears the gate opened, the person
  // answers through POST /v1/inbox/answers, the answer lands on the gate once, and the workflow finishes with it.
  const gateAgent = await ok("/v1/agents", { model: "wf-fixture/wf-model", codeMode: false, fileTools: false, builtins: ["delegate"], delegate: { instructions: true } });
  await ok(`/v1/agents/${gateAgent.id}/prompt`, { text: "GATED go" });
  const gatedId = await until(async () => gatedWorkflowId, "the gated workflow's start");
  const gateItem = await until(async () => ((await ok(`/v1/inbox?root=${gatedId}`)).items as { id: string; agent: string; kind: string; version: number; message: string; recommendation?: unknown }[]).find(item => item.agent === gatedId) ?? false,
    "the gate's inbox item", 60_000, async () => ({ workflow: await ok(`/v1/workflows/${gatedId}`), items: await ok(`/v1/workflows/${gatedId}/items`) }));
  assert.equal(gateItem.kind, "decision");
  assert.equal(gateItem.message, "Ship it?");
  assert.equal((await ok(`/v1/workflows/${gatedId}`)).status, "waiting", "only the gate is open");
  const answer = { agent: gatedId, id: gateItem.id, version: gateItem.version, action: "accept", content: "hold" };
  const answered = await ok("/v1/inbox/answers", { requestId: `answer-${gatedId}`, answers: [answer] });
  assert.equal(answered.outcomes[0].outcome, "answered", JSON.stringify(answered));
  const gateDone = await until(async () => { const value = await ok(`/v1/workflows/${gatedId}`); return value.status === "completed" && value; }, "the gated workflow", 60_000,
    async () => ({ workflow: await ok(`/v1/workflows/${gatedId}`), items: await ok(`/v1/workflows/${gatedId}/items`) }));
  assert.deepEqual(gateDone.result, { go: "hold" });
  // The same answer again is the same; another, under a new request, finds it settled. It left the inbox.
  const again = await ok("/v1/inbox/answers", { requestId: `again-${gatedId}`, answers: [{ ...answer, content: "ship" }] });
  assert.equal(again.outcomes[0].outcome, "conflict", JSON.stringify(again));
  assert.equal(((await ok(`/v1/inbox?root=${gatedId}`)).items as unknown[]).length, 0);
  const gateRow = (await fixture.db.query("select owner_kind, owner_id, state from agent_inputs where id = $1", [gateItem.id])).rows[0];
  assert.deepEqual(gateRow, { owner_kind: "workflow", owner_id: gatedId, state: "answered" });
  await until(async () => ((await ok(`/v1/agents/${gateAgent.id}`)).requests as { id: string; outcome?: { result?: { reply?: string } } }[])
    .some(request => request.id === `child_${gatedId}_a000001` && String(request.outcome?.result?.reply ?? "").startsWith("REPORT ")), "the owner's report of the gated workflow");


  // An agent's workflow that stops for its budget: the owner hears the stop (its row's first attempt, status paused),
  // raises the budget with workflow_budget, and hears the ending as the row's second attempt. Two turns, in order.
  const budgetAgent = await ok("/v1/agents", { model: "wf-fixture/wf-model", codeMode: false, fileTools: false, builtins: ["delegate"], delegate: { instructions: true } });
  await ok(`/v1/agents/${budgetAgent.id}/prompt`, { text: "BUDGETED go" });
  const budgetTurns = await until(async () => {
    const requests = ((await ok(`/v1/agents/${budgetAgent.id}`)).requests as { id: string; state: string; outcome?: { result?: { reply?: string } } }[]).filter(request => budgetWorkflowId && request.id.startsWith(`child_${budgetWorkflowId}_a`));
    return requests.length === 2 && requests.every(request => request.state === "completed") && requests;
  }, "the budget stop and the ending", 180_000, async () => ({ workflow: budgetWorkflowId && await ok(`/v1/workflows/${budgetWorkflowId}`), requests: (await ok(`/v1/agents/${budgetAgent.id}`)).requests }));
  assert.deepEqual(budgetTurns.map(request => [request.id, String(request.outcome?.result?.reply ?? "").split(" ")[0]]).sort(), [[`child_${budgetWorkflowId}_a000001`, "RAISED"], [`child_${budgetWorkflowId}_a000002`, "REPORT"]]);
  const budgetReport = JSON.parse(String(budgetTurns.find(request => request.id === `child_${budgetWorkflowId}_a000002`)!.outcome!.result!.reply).slice("REPORT ".length));
  assert.equal(budgetReport.status, "completed");
  assert.deepEqual(budgetReport.result, ["costly answer", "plain answer to cheap two"]);
  assert.equal((await ok(`/v1/workflows/${budgetWorkflowId}`)).budget.usd, 5);
});
