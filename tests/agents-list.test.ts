import { test } from "node:test";
import assert from "node:assert/strict";
import { failureClass } from "../src/client-sessions/state.ts";
import { runtime, lastUser, OTHER_OPERATOR } from "./runtime-server.ts";

test("a failed run's class is a short code, never its text", () => {
  assert.equal(failureClass({ outcome: { result: { text: "Done" } } }), undefined);
  assert.equal(failureClass({ outcome: { result: { stopped: "input_required" } } }), undefined);
  assert.equal(failureClass({ outcome: { result: { stopped: "spend_limit", error: "Over the agent's $1 limit" } } }), "spend_limit");
  assert.equal(failureClass({ outcome: { result: { error: "The run was aborted", code: "aborted" } } }), "aborted");
  assert.equal(failureClass({ outcome: { result: { error: "429 from provider: slow down, user said: secret", code: "Not A Code!" } } }), "model_error");
  assert.equal(failureClass({ outcome: { result: { error: "400 Bad request: the prompt was …" } } }), "model_error");
  assert.equal(failureClass({ outcome: { error: "The runtime restarted during this request", uncertain: true } }), "runtime_restart");
  assert.equal(failureClass({ outcome: { error: "Tool server crashed" } }), "runtime_error");
});

test("GET /v1/agents pages by cursor, filters by workspace, status and search, and lists activity and the last failure", async t => {
  const r = await runtime(t, body => lastUser(body).includes("fail") ? { httpStatus: 400, message: "provider says the secret prompt is bad" } : { role: "assistant", content: "Done" }, { AGENT_MAX_AGENTS_PER_TENANT: "10" });
  const ids: Record<string, string> = {};
  for (const name of ["alpha desk", "beta desk", "gamma lab", "delta lab", "epsilon_x"]) {
    const created = await r.call("/v1/agents", { body: { name }, headers: { "Idempotency-Key": `list-${name.replace(/\W/g, "-")}` } });
    assert.equal(created.status, 201, created.text);
    ids[name] = created.json.id;
  }
  const workspace = (await r.call("/v1/workspaces", { body: { name: "Desk" } })).json.id;
  for (const name of ["alpha desk", "beta desk"]) {
    assert.equal((await r.call(`/v1/workspace-memberships/agent/${ids[name]}`, { method: "PUT", body: { workspaceId: workspace } })).status, 200);
  }
  const before = Date.now();
  const ok = await r.prompt(ids["alpha desk"], "Hello");
  assert.equal(ok.status, "completed");
  const failed = await r.prompt(ids["gamma lab"], "Please fail");
  assert.equal(failed.status, "failed", JSON.stringify(failed));

  // No limit: the whole list, as callers have always had it, with the new fields.
  const all = await r.call("/v1/agents");
  assert.equal(all.status, 200);
  assert.equal(all.headers.get("x-next-cursor"), null);
  const sorted = Object.values(ids).sort();
  assert.deepEqual(all.json.map((agent: any) => agent.id), sorted);
  const byId = (list: any[], id: string) => list.find(agent => agent.id === id);
  assert.equal(byId(all.json, ids["alpha desk"]).workspaceId, workspace);
  assert.equal(byId(all.json, ids["gamma lab"]).workspaceId, null);
  // Written once the run's outcome is durable: a moment after the request reads completed.
  const activity = async () => (await r.call("/v1/agents")).json;
  let listed = await activity();
  for (let tries = 0; tries < 50 && (!byId(listed, ids["gamma lab"]).lastError || !byId(listed, ids["alpha desk"]).lastActiveAt); tries++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    listed = await activity();
  }
  const alpha = byId(listed, ids["alpha desk"]), gamma = byId(listed, ids["gamma lab"]), delta = byId(listed, ids["delta lab"]);
  assert.ok(alpha.lastActiveAt >= before, JSON.stringify(alpha));
  assert.equal(alpha.lastError, null);
  assert.equal(delta.lastActiveAt, null);
  assert.ok(gamma.lastError.at >= before);
  assert.match(gamma.lastError.class, /^[a-z][a-z0-9_]*$/);
  assert.doesNotMatch(JSON.stringify(listed), /secret/);

  // Pages: each limit long, by id, the header leading to the next until the last.
  const paged: string[] = [];
  let cursor: string | null = null, pages = 0;
  do {
    const page = await r.call(`/v1/agents?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.status, 200, page.text);
    assert.ok(page.json.length <= 2);
    paged.push(...page.json.map((agent: any) => agent.id));
    cursor = page.headers.get("x-next-cursor");
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(paged, sorted);

  const ids_ = async (query: string, token?: string) => {
    const response = await r.call(`/v1/agents?${query}`, { token });
    assert.equal(response.status, 200, `${query}: ${response.text}`);
    return response.json.map((agent: any) => agent.id).sort();
  };
  assert.deepEqual(await ids_(`workspaceId=${workspace}`), [ids["alpha desk"], ids["beta desk"]].sort());
  assert.deepEqual(await ids_("workspaceId=unassigned"), [ids["gamma lab"], ids["delta lab"], ids["epsilon_x"]].sort());
  assert.deepEqual(await ids_("status=failed"), [ids["gamma lab"]]);
  assert.deepEqual(await ids_("status=failed&workspaceId=" + workspace), []);
  assert.deepEqual(await ids_("q=LAB"), [ids["gamma lab"], ids["delta lab"]].sort());
  assert.deepEqual(await ids_(`q=${ids["beta desk"].slice(-8)}`), [ids["beta desk"]]);
  // LIKE's wildcards are literal: "_" matches only an underscore.
  assert.deepEqual(await ids_("q=n_x"), [ids["epsilon_x"]]);
  assert.deepEqual(await ids_("q=a%25d"), []);
  assert.deepEqual(await ids_("subAgents=only"), []);
  assert.deepEqual(await ids_("subAgents=exclude"), sorted);
  for (const agent of (await r.call("/v1/agents?status=expiring")).json) assert.notEqual(agent.expiresAt, null);
  for (const agent of (await r.call("/v1/agents?status=running")).json) assert.equal(agent.running, true);
  assert.deepEqual(await ids_("", OTHER_OPERATOR), []);
  assert.deepEqual(await ids_(`workspaceId=${workspace}`, OTHER_OPERATOR), []);

  // GET /v1/agents/{id} has the same summary.
  assert.equal((await r.call(`/v1/agents/${ids["alpha desk"]}`)).json.workspaceId, workspace);

  for (const query of ["limit=0", "limit=201", "limit=two", "cursor=not-a-cursor!", "status=sleeping", "subAgents=maybe", `q=${"x".repeat(201)}`]) {
    assert.equal((await r.call(`/v1/agents?${query}`)).status, 400, query);
  }
});
