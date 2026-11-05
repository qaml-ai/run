import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("definition revisions, imported history, forks and hidden stateless sessions", { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  async function request(path: string, input?: unknown, method = input === undefined ? "GET" : "POST", headers: Record<string,string> = {}) {
    const response = await fetch(fixture.url + path, { method, headers: { Authorization: `Bearer ${fixture.token}`, "content-type": "application/json", ...headers }, body: input === undefined ? undefined : JSON.stringify(input) });
    const value = await response.json() as any;
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  const definition = await request("/v1/definitions", { name: "Helper", systemPrompt: "Reply simply.", fileTools: false, codeMode: false }, "POST", { "Idempotency-Key": "helper" });
  assert.equal(definition.revision, 1);
  assert.equal((await request("/v1/definitions/helper")).id, definition.id);
  const revised = await request(`/v1/definitions/${definition.id}`, { revision: 1, systemPrompt: "Reply briefly." }, "PATCH");
  assert.equal(revised.revision, 2);
  const agent = await request("/v1/agents", { definition: "helper", importMessages: { format: "openai-chat", messages: [{role:"user",content:"My name is Ada."}] } }, "POST", { "Idempotency-Key": "imported" });
  assert.equal((await request(`/v1/agents/${agent.id}/history`)).messages[0].content, "My name is Ada.");
  const write = await fetch(fixture.url + `/v1/agents/${agent.id}/files/workspace/note.txt`, {method:"PUT",headers:{Authorization:`Bearer ${fixture.token}`,"content-type":"text/plain"},body:"Before fork"});
  assert.equal(write.status,201);
  const own = await request("/v1/agents", { definition: "helper", maxOutputTokens: 150 }, "POST", { "Idempotency-Key": "own-override" });
  const applied = await request(`/v1/definitions/${definition.id}`, { revision: 2, maxOutputTokens: 200, apply: "all" }, "PATCH");
  assert.ok(applied.applied.every((item:any) => item.status === "updated"));
  assert.equal((await request(`/v1/agents/${agent.id}/configuration`)).maxOutputTokens, 200);
  assert.equal((await request(`/v1/agents/${own.id}/configuration`)).maxOutputTokens, 150);
  const fork = await request(`/v1/agents/${agent.id}/fork`, { key:"forked", atMessage:0 });
  assert.equal(fork.forkedFrom.agentId, agent.id);
  const cloned = await fetch(fixture.url + `/v1/agents/${fork.id}/files/workspace/note.txt`, {headers:{Authorization:`Bearer ${fixture.token}`}});
  assert.equal(await cloned.text(),"Before fork");
  await fetch(fixture.url + `/v1/agents/${fork.id}/files/workspace/note.txt`, {method:"PUT",headers:{Authorization:`Bearer ${fixture.token}`,"content-type":"text/plain"},body:"After fork"});
  const original = await fetch(fixture.url + `/v1/agents/${agent.id}/files/workspace/note.txt`, {headers:{Authorization:`Bearer ${fixture.token}`}});
  assert.equal(await original.text(),"Before fork");


  assert.equal((await request(`/v1/agents/${fork.id}/history`)).messages.length, 1);
  assert.equal((await request(`/v1/agents/${agent.id}/fork`, { key:"forked", atMessage:0 })).id, fork.id);
  const run = await request("/v1/runs", { input: "once", wait:true }, "POST", { "Idempotency-Key":"once" });
  assert.equal(run.status, "completed");
  assert.equal(run.text, "Echo: once");
  assert.match(run.id, /^run_/);
  assert.equal((await request("/v1/runs", {input:"once",wait:true}, "POST", {"Idempotency-Key":"once"})).id, run.id);
  assert.equal((await request(`/v1/runs/${run.id}`)).text, run.text);
  assert.deepEqual((await request(`/v1/runs/${run.id}/messages`)).map((message:any) => message.role), ["user","assistant"]);
  assert.equal((await request("/v1/agents")).some((entry:any) => entry.type === "run"), false);
  const conflict = await fetch(fixture.url + "/v1/runs", {method:"POST",headers:{Authorization:`Bearer ${fixture.token}`,"content-type":"application/json","Idempotency-Key":"once"},body:JSON.stringify({input:"different"})});
  assert.equal(conflict.status,409);
  await request(`/v1/definitions/${definition.id}`, undefined, "DELETE");
});
