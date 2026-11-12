import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import type { AgentJobsHost } from "../src/agent-jobs.ts";
import type { JobResult, JobSpec } from "../src/jobs/job.ts";

// The volume and workflow modules reach Durable Objects; a stand-in base class lets them load in Node.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { agentJobId, agentJobTools, jobRunResult, jobRunSpec, runJob, JOB_RUN_INLINE_CHARS, JOB_RUN_MAX_SECONDS } = await import("../src/agent-jobs.ts");
const { WORKFLOW_START_DESCRIPTION, WORKFLOWS_PROMPT_SECTION, workflowStartDescription } = await import("../src/workflow-tools.ts");
hooks.deregister();

// The jobs builtin: an agent runs one command in a container of its own, paid by itself, once per tool call.

const bytes = (text: string) => new TextEncoder().encode(text);
const timings = { startedAt: 0, endedAt: 1500, startMs: 100, syncMs: 0, commandMs: 1300, collectMs: 100, totalMs: 1500 };
function host(answer: (spec: JobSpec) => JobResult, run = "run_1") {
  const runs: JobSpec[] = [], stored = new Map<string, unknown>();
  const env = { COMPUTER_CONTAINERS: { getByName: (name: string) => ({
    runJob: async (spec: JobSpec) => { assert.equal(name, `job:${spec.id}`); runs.push(spec); return answer(spec); },
    stopJob: async () => ({ stopped: true }),
  }) } };
  const value: AgentJobsHost = {
    env: env as never, tenant: "t1", agentId: "client_a", runId: async () => run,
    storage: {
      get: async (key: string) => stored.get(key), put: async (key: string, data: unknown) => { stored.set(key, data); },
      list: async ({ prefix }: { prefix: string }) => new Map([...stored].filter(([key]) => key.startsWith(prefix))), delete: async (key: string) => stored.delete(key),
    } as never,
  };
  return { host: value, runs, stored };
}
const ok = (spec: JobSpec, overrides: Partial<Extract<JobResult, { ok: true }>> = {}): JobResult => ({
  ok: true, id: spec.id, instance: "lite" as never, exitCode: 0, timedOut: false,
  stdout: { bytes: bytes("built\n"), size: 6, truncated: false }, stderr: { bytes: bytes(""), size: 0, truncated: false },
  outputs: {}, missing: [], timings, costUsd: 0.0004, ...overrides,
});

test("job_run runs the command once per call, paid by the agent, and answers its exit code and output", async () => {
  const h = host(spec => ok(spec, { outputs: { "report.txt": { bytes: bytes("3 passed"), size: 8, truncated: false } } }));
  const args = { command: "go build ./... && go test ./... > $JOB_OUT/report.txt", files: { "go.mod": "module x\n" }, outputs: ["report.txt"], timeoutSeconds: 120 };
  const answer = await runJob(h.host, "call_1", args) as Record<string, unknown>;
  assert.deepEqual(answer, { ok: true, exitCode: 0, timedOut: false, stdout: "built\n", stderr: "", outputs: { "report.txt": "3 passed" }, seconds: 1.5 });
  const [spec] = h.runs;
  assert.equal(spec.id, await agentJobId("client_a", "call_1"));
  assert.deepEqual(spec.payer, { tenant: "t1", agent: "client_a" }, "billed as the agent's own computer time");
  assert.equal(spec.timeoutSeconds, 120);
  assert.equal(spec.internet, undefined, "no Internet unless asked");
  assert.deepEqual(Object.keys(spec.files!), ["go.mod"]);
  // The call made again (a replay) answers the same, and runs nothing.
  assert.deepEqual(await runJob(h.host, "call_1", args), answer);
  assert.equal(h.runs.length, 1);
  // Another call is another job.
  await runJob(h.host, "call_2", args);
  assert.notEqual(h.runs[1]!.id, spec.id);
});

test("job_run: failures are results, long output is cut to its end, a bad call is refused before any compute", async () => {
  const long = "x".repeat(JOB_RUN_INLINE_CHARS) + "THE END";
  const h = host(spec => spec.command === "fail"
    ? { ok: false, id: spec.id, code: "admission_refused", message: "Spend limit reached", timings }
    : ok(spec, { exitCode: 2, stdout: { bytes: bytes(long), size: long.length, truncated: false } }));
  assert.deepEqual(await runJob(h.host, "a", { command: "fail" }), { ok: false, code: "admission_refused", error: "Spend limit reached" });
  const cut = await runJob(h.host, "b", { command: "make" }) as { exitCode: number; stdout: string };
  assert.equal(cut.exitCode, 2);
  assert.ok(cut.stdout.endsWith("THE END") && cut.stdout.length < long.length + 100 && cut.stdout.startsWith("…("));
  for (const [args, error] of [
    [{}, /command/], [{ command: "x", timeoutSeconds: JOB_RUN_MAX_SECONDS + 1 }, /timeoutSeconds/], [{ command: "x", at: "vol_1", files: {} }, /at or files/],
    [{ command: "x", outputs: "a" }, /outputs/],
  ] as const) {
    const refused = await runJob(h.host, `bad-${JSON.stringify(args)}`, args as never) as { ok: boolean; code: string; error: string };
    assert.equal(refused.code, "JOB_INVALID");
    assert.match(refused.error, error);
  }
  assert.equal(h.runs.length, 2, "the refused calls started nothing");
  // Still running elsewhere (the call made again while its first run holds the container): not kept as its result.
  const busy = host(spec => ({ ok: false, id: spec.id, code: "job_running", message: "running", timings }));
  assert.equal((await runJob(busy.host, "c", { command: "sleep 1" }) as { code: string }).code, "job_running");
  assert.equal(busy.stored.size, 0);
  assert.equal(jobRunResult({ ok: false, id: "j", code: "container_failed", message: "out of memory", timings }).code, "container_failed");
  assert.equal((await jobRunSpec(h.host, "j", { command: "curl x", internet: true })).internet, true);
});

test("the builtin exists only where a job driver does; workflow_start points at it then", () => {
  assert.equal(agentJobTools({ env: {} as never, tenant: "t", agentId: "a", storage: {} as never, runId: async () => "r" }).length, 0);
  const tools = agentJobTools(host(spec => ok(spec)).host);
  assert.deepEqual(tools.map(tool => tool.name), ["job_run"]);
  assert.ok(!WORKFLOW_START_DESCRIPTION.includes("job_run"));
  assert.match(workflowStartDescription(true), /Do not do the units yourself\. Run a single command with job_run, not a workflow\. Use delegate/);
  // The builtin's prompt section says when to write one in the description's own terms.
  for (const phrase of ["more than about 10 files, tables, documents or sources", "port, migration, audit or research sweep", "give each to its own agent()", "planning, checking and reporting"])
    assert.ok(WORKFLOW_START_DESCRIPTION.includes(phrase) && WORKFLOWS_PROMPT_SECTION.includes(phrase), phrase);
});

test("job_run in a turn no request started (run id background) is refused and runs nothing", async () => {
  const h = host(spec => ok(spec), "background");
  const [tool] = agentJobTools(h.host);
  const answer = await tool!.execute({ command: "echo hi" } as never, { callId: "call_0" } as never) as { structuredOutput: { ok: boolean; code: string } };
  assert.deepEqual([answer.structuredOutput.ok, answer.structuredOutput.code], [false, "JOB_UNAVAILABLE"]);
  assert.equal(h.runs.length, 0);
  // In a request, the same call id runs, named by the run.
  const inRun = host(spec => ok(spec), "req_9");
  await agentJobTools(inRun.host)[0]!.execute({ command: "echo hi" } as never, { callId: "call_0" } as never);
  assert.equal(inRun.runs[0]!.id, await agentJobId("client_a", "req_9:call_0"));
});
