import { test } from "node:test";
import assert from "node:assert/strict";
import { Workspaces, applyWorkspaceUsage } from "../src/workspaces.ts";
import { Accounts, applyUsageRows, type Totals } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { runtime, sleep, OTHER_OPERATOR } from "./runtime-server.ts";

const totals: Totals = { responses: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.2, platformResponses: 1, platformCost: 0.2 };

test("workspace assignment history keeps delayed usage and signed reconciliation in the original workspace", async () => {
  const { db } = await testDatabase();
  const groups = new Workspaces(db);
  const first = await groups.create("alice", "Trading Desk"), second = await groups.create("alice", "Other");
  await groups.assign("alice", "agent", "a", first.id);
  const at = Date.now();
  await sleep(5);
  await groups.assign("alice", "agent", "a", second.id);
  const next = Date.now();
  const day = new Date(at).toISOString().slice(0, 10);
  const rows = [
    { tenant: "alice", agent: "a", timestamp: at, day, model: "xai/x_search", ...totals },
    { tenant: "alice", agent: "a", timestamp: next, day, model: "p/model", ...totals },
    { tenant: "alice", agent: "a", timestamp: at, day, model: "xai/x_search", ...totals, responses: 0, cost: -0.05, platformCost: -0.05, input: 0, output: 0, platformResponses: 0 },
  ];
  // Account totals are batched by model before applying, as Accounts and ModelAttempts do.
  for (const row of rows) { await applyUsageRows(db, [row]); await applyWorkspaceUsage(db, [row]); }
  const accounts = new Accounts({ db, tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }) });
  const report = await accounts.usage("alice", Date.now() - 86400_000);
  assert.equal(report.totals.responses, 2);
  assert.ok(Math.abs(report.workspaces.find(row => row.id === first.id)!.cost - 0.15) < 1e-9);
  assert.equal(report.workspaces.find(row => row.id === second.id)!.cost, 0.2);
  assert.ok(Math.abs((await accounts.usage("alice", 0, first.id)).totals.cost - 0.15) < 1e-9);
  await groups.assign("alice", "agent", "a", null);
  await groups.update("alice", first.id, { archived: true });
  await assert.rejects(groups.assign("alice", "agent", "b", first.id), /archived/);
  await assert.rejects(groups.assign("bob", "agent", "b", first.id), /Unknown workspace/);
  assert.equal((await groups.current("alice", "agent", "a"))!.workspace, null);
  assert.equal((await groups.list("bob")).length, 0);
});

test("workspaces API validates ownership, inherits definitions, and accounts agent and stateless model calls", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "Done", usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.2 } }));
  const create = await r.call("/v1/workspaces", { body: { name: "  Trading Desk  " } });
  assert.equal(create.status, 201);
  const workspace = create.json.id;
  assert.equal((await r.call(`/v1/workspaces/${workspace}/members`, { token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call("/v1/agents", { token: OTHER_OPERATOR, body: { workspaceId: workspace } })).status, 404);
  assert.equal(create.json.name, "Trading Desk");
  assert.equal((await r.call("/v1/workspaces", { body: { name: "  " } })).status, 400);
  const definition = (await r.call("/v1/definitions", { body: { name: "Research" } })).json.id;
  assert.equal((await r.call(`/v1/workspace-memberships/definition/${definition}`, { method: "PUT", body: { workspaceId: workspace } })).status, 200);
  const agent = await r.call("/v1/agents", { body: { definition }, headers: { "Idempotency-Key": "workspace-agent" } });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));
  assert.ok((await r.call(`/v1/workspaces/${workspace}/members`)).json.some((member: any) => member.id === agent.json.id));
  const fork = await r.call(`/v1/agents/${agent.json.id}/fork`, { body: { name: "Research fork" } });
  assert.equal(fork.status, 201);
  assert.ok((await r.call(`/v1/workspaces/${workspace}/members`)).json.some((member: any) => member.id === fork.json.id));
  await r.prompt(agent.json.id, "Research");
  const run = await r.call("/v1/runs?wait=30", { body: { input: "Check", workspaceId: workspace } });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  const report = await r.call(`/v1/usage?workspaceId=${workspace}`);
  assert.equal(report.json.totals.responses, 2);
  assert.equal(report.json.totals.cost, 0.4);
  const unassigned = await r.call("/v1/runs?wait=30", { body: { input: "Separate", workspaceId: null } });
  assert.equal(unassigned.status, 200);
  assert.ok(Math.abs((await r.call("/v1/usage?workspaceId=unassigned")).json.totals.cost - 0.2) < 1e-9);
  assert.equal((await r.call(`/v1/workspace-memberships/agent/${agent.json.id}`, { method: "PUT", body: { workspaceId: null } })).status, 200);
  // An upsert without workspaceId must preserve an explicit unassignment.
  assert.equal((await r.call("/v1/agents", { body: { definition }, headers: { "Idempotency-Key": "workspace-agent" } })).status, 201);
  const assignments = (await r.call("/v1/workspace-memberships")).json;
  assert.equal(assignments.find((row: any) => row.id === agent.json.id).workspaceId, null);
  assert.equal((await r.call(`/v1/workspace-memberships/agent/${agent.json.id}`, { method: "PUT", body: { workspaceId: "ws_missing" } })).status, 404);
  assert.equal((await r.call(`/v1/usage?workspaceId=ws_missing`)).status, 404);
  await r.call(`/v1/workspaces/${workspace}`, { method: "PATCH", body: { archived: true } });
  assert.equal((await r.call("/v1/agents", { body: { workspaceId: workspace } })).status, 409);
  assert.equal((await r.call(`/v1/usage?workspaceId=${workspace}`)).json.totals.cost, 0.4);
});
