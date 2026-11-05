import assert from 'node:assert/strict';
import { contractTest, OTHER_OPERATOR } from '../support.ts';

contractTest("workspaces", "tests/workspaces.test.ts:48", "workspaces API validates ownership, inherits definitions, and accounts agent and stateless model calls", async (t, r) => {
  r.setModel(() => ({ role: "assistant", content: "Done", usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.2 } }));
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
}, {});

