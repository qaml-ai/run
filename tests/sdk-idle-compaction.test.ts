import assert from "node:assert/strict";
import { test } from "node:test";
import { Agents, type SessionCredentials } from "../clients/typescript.ts";

test("SDK preserves idle compaction opt-outs on create, upsert and configure", async (t) => {
  const session: SessionCredentials = { id: `client_${"a".repeat(40)}`, token: "agent-token", expiresAt: null };
  const provisioning: Record<string, unknown>[] = [];
  const configurations: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    if (path === "/v1/agents") {
      provisioning.push(body);
      return Response.json(session);
    }
    assert.equal(path, `/clients/${session.id}/requests`);
    assert.equal(body.method, "configure");
    configurations.push(body.params);
    return Response.json({ id: body.id, state: "completed", outcome: { result: {} } });
  };
  const agents = new Agents({ apiKey: "tenant-token", url: "https://runtime.example", fetch: fetcher });
  t.after(() => agents.close());
  const runtime = agents.runtime;
  const client = await runtime.createAgent({ tools: {}, attach: false, connection: "lazy", idleCompaction: false });
  t.after(() => client.close());
  const defaultClient = await runtime.createAgent({ tools: {}, attach: false, connection: "lazy" });
  t.after(() => defaultClient.close());
  const agent = await agents.upsert("opt-out", { idleCompaction: false });
  await agents.upsert("default");

  await client.configure({ idleCompaction: false });
  await agent.configure({ idleCompaction: true });
  await agent.configure({ instructions: "Updated instructions" });

  assert.equal(provisioning.length, 4);
  for (const body of [provisioning[0], provisioning[2]]) assert.equal(body.idleCompaction, false);
  for (const body of [provisioning[1], provisioning[3]]) assert.equal(Object.hasOwn(body, "idleCompaction"), false);
  assert.deepEqual(configurations, [{ idleCompaction: false }, { idleCompaction: true }, { systemPrompt: "Updated instructions" }]);
});
