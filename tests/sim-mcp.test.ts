import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SimLab } from "./sim/lab.ts";
import { simServer } from "./sim/mcp.ts";
import { generatePlan } from "./sim/workload.ts";

// The simulator's MCP server (npm run sim:mcp): an agent writes plans, runs them and looks into them.

test("an agent reads the schema and goals, runs a plan, looks into the run and keeps it in the corpus", async t => {
  const dir = mkdtempSync(join(tmpdir(), "sim-mcp-"));
  const lab = new SimLab({ dir: join(dir, "runs"), corpus: join(dir, "corpus") });
  await lab.start();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await simServer(lab).connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  t.after(async () => { await client.close(); await lab.stop(); rmSync(dir, { recursive: true, force: true }); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };

  const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(tools, ["branch", "corpus_add", "corpus_list", "fuzz", "goals", "inspect", "minimize", "replay", "run_plan", "run_seeds", "schema"]);
  const schema = await call("schema");
  assert.ok(schema.plan.properties.steps && schema.checkers.I3 && schema.buggifySites.length);

  const goals = await call("goals");
  const acquire = goals.find((goal: any) => goal.message === "an acquire tried again after a heartbeat expired between its statements");
  assert.equal(acquire.file, "src/ownership.ts");
  assert.equal(acquire.reachedHere, false);

  // A plan the schema refuses says why, and runs nothing.
  const refused = await call("run_plan", { plan: { ...generatePlan("1"), nodes: ["a"], steps: [{ at: 5, op: { op: "crash", node: "z" } }, { at: 9, op: { op: "fly" } }] } });
  assert.ok(refused.errors.length && refused.errors.some((error: string) => error.startsWith("steps.1.op")), JSON.stringify(refused));
  const twice = await call("run_plan", { plan: { ...generatePlan("1"), steps: [{ at: 1, op: { op: "prompt", agent: 0, run: 1, node: "a" } }, { at: 2, op: { op: "prompt", agent: 0, run: 1, node: "a" } }] } });
  assert.match(twice.errors[0], /run 1 used twice/);

  const plan = { seed: "mcp", nodes: ["a", "b"], skews: {}, leaseTtlMs: 3_000, modelDelayMs: [50, 500], buggify: false, durationMs: 20_000, steps: [
    { at: 0, op: { op: "create", agent: 0, node: "a" } },
    { at: 1_000, op: { op: "prompt", agent: 0, run: 0, node: "b" } },
    { at: 1_100, op: { op: "crash", node: "a" } },
    { at: 5_000, op: { op: "prompt", agent: 0, run: 1, node: "b" } },
  ] };
  const run = await call("run_plan", { plan, twice: true });
  assert.deepEqual(run.failures, []);
  assert.match(run.runId, /^r\d+$/);
  assert.ok(run.newCoverage > 100 && run.trace.items.length >= 4, JSON.stringify(run));
  // The same plan again covers nothing new.
  assert.equal((await call("run_plan", { plan })).newCoverage, 0);

  const looked = await call("inspect", { runId: run.runId, logs: "/drain|heartbeat/", agent: 0, state: true, limit: 5 });
  assert.equal(looked.agent.requests.length, 2);
  assert.ok(looked.agent.requests.every((record: any) => record.state === "completed"));
  assert.ok(looked.state.actor_owners.length >= 1);
  assert.ok(looked.logs.items.length <= 5);

  const kept = await call("corpus_add", { runId: run.runId, note: "a crash before the first run" });
  const listed = await call("corpus_list");
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].corpus, kept.corpus);
  assert.equal(listed.items[0].note, "a crash before the first run");

  const branched = await call("branch", { runId: run.runId, k: 2, n: 2 });
  assert.equal(branched.runs.length, 2);
  const replayed = await call("replay", { corpus: kept.corpus });
  assert.deepEqual(replayed.failures, []);
});
