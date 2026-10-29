import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflowScript, workflowAgentSummary, WORKFLOW_LIMITS } from "../src/workflows.ts";


const call = (answer: (prompt: string) => unknown) => async (request: { prompt: string }) => ({ value: answer(request.prompt) });

test("a script's agent, parallel, pipeline, phase, log and args reach the host and come back", async () => {
  const phases: string[] = [];
  const logs: string[] = [];
  const prompts: string[] = [];
  const result = await runWorkflowScript({
    script: `
      phase("one")
      const a = await agent(\`first \${args.n}\`)
      phase("many")
      const list = await parallel([agent("p1"), agent("p2")])
      const piped = await pipeline(list, item => agent(\`stage \${item}\`), item => \`\${item}!\`)
      log(\`did \${piped.length}\`)
      return { a, list, piped }
    `,
    args: { n: 7 },
    maxAgents: 10, items: 10, timeMs: 20_000,
    callAgent: call(prompt => { prompts.push(prompt); return prompt.toUpperCase(); }),
    onPhase: title => phases.push(title),
    onLog: message => logs.push(message),
  });
  assert.equal(result.status, "completed", result.error);
  assert.deepEqual(result.value, { a: "FIRST 7", list: ["P1", "P2"], piped: ["STAGE P1!", "STAGE P2!"] });
  assert.deepEqual(phases, ["one", "many"]);
  assert.deepEqual(logs, ["did 2"]);
  assert.deepEqual(prompts, ["first 7", "p1", "p2", "stage P1", "stage P2"]);
});

test("a failed agent call is null to the script, and a thrown error fails the run", async () => {
  const outcome = await runWorkflowScript({
    script: `const ok = await agent("fine"); const bad = await agent("fail"); return { ok, bad }`,
    maxAgents: 4, items: 4, timeMs: 10_000,
    callAgent: async request => request.prompt === "fail" ? { failed: true, error: "nope" } : { value: "yes" },
  });
  assert.equal(outcome.status, "completed", outcome.error);
  assert.deepEqual(outcome.value, { ok: "yes", bad: null });

  const failed = await runWorkflowScript({ script: `throw new Error("script broke")`, maxAgents: 2, items: 2, timeMs: 10_000, callAgent: call(() => 1) });
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /script broke/);
});

test("caps and refusals: agent calls, list items, imports, and the deadline", async () => {
  const overAgents = await runWorkflowScript({
    script: `for (let i = 0; i < 5; i++) await agent("x" + i); return "done"`,
    maxAgents: 3, items: 10, timeMs: 10_000, callAgent: call(() => "ok"),
  });
  assert.equal(overAgents.status, "failed");
  assert.match(overAgents.error ?? "", /at most 3 agent calls|more than 3 agent calls/);

  const overItems = await runWorkflowScript({ script: `return await parallel([1,2,3,4].map(i => agent("x" + i)))`, maxAgents: 10, items: 3, timeMs: 10_000, callAgent: call(() => "ok") });
  assert.equal(overItems.status, "failed");
  assert.match(overItems.error ?? "", /at most 3 items/);

  const imported = await runWorkflowScript({ script: `const fs = await import("node:fs"); return fs`, maxAgents: 2, items: 2, timeMs: 1_000, callAgent: call(() => 1) });
  assert.equal(imported.status, "failed");
  assert.match(imported.error ?? "", /cannot import/);
  const oversized = await runWorkflowScript({ script: "x", args: { big: "x".repeat(WORKFLOW_LIMITS.argsBytes) }, maxAgents: 2, items: 2, timeMs: 1_000, callAgent: call(() => 1) });
  assert.equal(oversized.status, "failed");
  assert.match(oversized.error ?? "", /args are at most/);

  // A script that never returns is stopped at its deadline, and its sandbox with it.
  const deadline = await runWorkflowScript({ script: `while (true) {}`, maxAgents: 2, items: 2, timeMs: 300, callAgent: call(() => 1) });
  assert.equal(deadline.status, "failed");
  assert.match(deadline.error ?? "", /did not finish within/);
});

test("a fan-out larger than the sandbox's concurrent tool calls queues in the script, and every item is answered", async () => {
  const seen = { inFlight: 0, most: 0, calls: 0 };
  const result = await runWorkflowScript({
    script: `const answers = await pipeline(Array.from({ length: 40 }, (_, i) => i), i => agent("item " + i)); return answers`,
    maxAgents: 40, items: 512, timeMs: 60_000, parallel: 4,
    callAgent: async request => {
      seen.calls++;
      seen.inFlight++;
      seen.most = Math.max(seen.most, seen.inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      seen.inFlight--;
      return { value: request.prompt };
    },
  });
  assert.equal(result.status, "completed", result.error);
  assert.equal((result.value as string[]).length, 40);
  assert.equal(seen.calls, 40);
  assert.ok(seen.most <= 4, `at most 4 agent calls at once, saw ${seen.most}`);
});

test("a script's clock and randomness are fixed for its run, so a replay asks the same questions", async () => {
  const answers = async (request: { prompt: string }) => ({ value: request.prompt });
  const script = `const a = await agent("a " + Date.now() + " " + Math.random()); const b = await agent("b " + Date.now() + " " + Math.random()); return { a, b }`;
  const first = await runWorkflowScript({ script, maxAgents: 4, items: 4, timeMs: 30_000, frozenNow: 1_700_000_000_000, seed: "wf-test-1", callAgent: answers });
  const second = await runWorkflowScript({ script, maxAgents: 4, items: 4, timeMs: 30_000, frozenNow: 1_700_000_000_000, seed: "wf-test-1", callAgent: answers });
  assert.equal(first.status, "completed", first.error);
  assert.deepEqual(second.value, first.value, "the same run's clock and dice, replayed");
  assert.match((first.value as { a: string }).a, /^a 1700000000000 0\.\d+$/);
});

test("answers are measured in bytes, cut at a UTF-8 boundary, and a wide non-ASCII fan-out fits", async () => {
  const long = await runWorkflowScript({
    script: `return await agent("big")`, maxAgents: 2, items: 4, timeMs: 30_000,
    callAgent: async () => ({ value: "x" + "é".repeat(WORKFLOW_LIMITS.answerChars) }),
  });
  assert.equal(long.status, "completed", long.error);
  const answer = String(long.value);
  assert.ok(answer.endsWith(`[answer cut at ${WORKFLOW_LIMITS.answerChars} bytes]`));
  assert.ok(Buffer.byteLength(answer.split("\n\n")[0], "utf8") <= WORKFLOW_LIMITS.answerChars, "cut on a byte boundary");
  assert.ok(!answer.includes("\uFFFD"), "a multibyte character crossing the boundary is omitted, not corrupted");

  // 120 calls of 12,000 two-byte characters each: 2.9 MB of answers, inside the workflow's budget.
  const wide = await runWorkflowScript({
    script: `const answers = await parallel(Array.from({ length: 120 }, (_, i) => agent("item " + i))); return answers.map(a => a.length)`,
    maxAgents: 120, items: 512, timeMs: 120_000, parallel: 16,
    callAgent: async () => ({ value: "é".repeat(12_000) }),
  });
  assert.equal(wide.status, "completed", wide.error);
  assert.deepEqual(new Set(wide.value as number[]), new Set([12_000]));

  // A return value too large for one sandbox message says so, instead of the transport's own complaint.
  const huge = await runWorkflowScript({
    script: `return Array.from({ length: 200 }, () => "x".repeat(12_000)).join("")`,
    maxAgents: 2, items: 4, timeMs: 30_000, callAgent: async () => ({ value: "x" }),
  });
  assert.equal(huge.status, "failed");
  assert.match(huge.error ?? "", /return value is larger than the sandbox carries/);
});

test("large workflows exceed the ordinary sandbox call, concurrency and transfer caps", async () => {
  let active = 0, peak = 0;
  const result = await runWorkflowScript({
    script: `return await pipeline(Array.from({ length: 512 }, (_, i) => i), async i => (await agent("item " + i)).length)`,
    maxAgents: WORKFLOW_LIMITS.agentsCeiling, items: WORKFLOW_LIMITS.items, timeMs: 60_000, parallel: 64,
    callAgent: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return { value: "x".repeat(64 * 1024) };
    },
  });
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.agents, 512);
  assert.ok(peak > 32 && peak <= 64, `workflow concurrency: ${peak}`);
  assert.deepEqual(result.value, Array(512).fill(64 * 1024));
});


test("large workflow arguments and return values cross the sandbox", async () => {
  const text = "x".repeat(200_000);
  const result = await runWorkflowScript({ script: "return args.text", args: { text }, maxAgents: 1, items: 1, timeMs: 10_000, callAgent: call(() => null) });
  assert.equal(result.status, "completed");
  assert.equal(result.value, text);
});

test("large workflow child metadata fits the tool envelope with an explicit omitted count", () => {
  const children = Array.from({ length: 4096 }, (_, index) => ({ index, label: "x".repeat(500), agentId: "a".repeat(50) }));
  const summary = workflowAgentSummary(children);
  assert.ok(Buffer.byteLength(JSON.stringify(summary.agents)) <= 128 * 1024);
  assert.equal(summary.agents.length + summary.agentsOmitted!, children.length);
  assert.deepEqual(workflowAgentSummary(children.slice(0, 2)), { agents: children.slice(0, 2) });
});
