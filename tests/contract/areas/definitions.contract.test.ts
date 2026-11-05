import { contractTest, createContractFixture, OPERATOR, OTHER_OPERATOR, toolCall, toolResults, until, type T } from '../support.ts';
import type { ModelReply, ContractFixture } from '../fixture.ts';
async function runtime(t:T, respond:ModelReply, env:Record<string,string>={}, tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

import { AgentRuntime } from "../../../clients/typescript.ts";

const lookup = { name: "lookup", description: "Look something up", parameters: { type: "object", properties: { key: { type: "string" } } }, exposure: "direct" };

const systemText = (body: any) => body.messages.find((message: any) => message.role === "system" || message.role === "developer")?.content as string;

contractTest("definitions", "tests/definitions.test.ts:17", "definitions are the tenant's own, validated, and revised", async (t, _f) => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const created = await r.call("/v1/definitions", { body: { name: "Support", systemPrompt: "You are support.", builtins: ["web_fetch"], limits: { ttlSeconds: 3600 } } });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;
  assert.match(id, /^def_[a-f0-9]{20}$/);
  assert.equal(created.json.revision, 1);
  assert.deepEqual(created.json.builtins, ["web_fetch"]);

  for (const body of [{ name: "" }, { systemPrompt: "no name" }, { name: "x", model: "nope/nope" }, { name: "x", limits: { ttlSeconds: 5 } }, { name: "x", thinkingLevel: "huge" }]) {
    assert.equal((await r.call("/v1/definitions", { body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await r.call("/v1/definitions", { body: { name: "Catalog model", model: "anthropic/claude-sonnet-5" } })).status, 201);

  // Another tenant sees none of it.
  assert.deepEqual((await r.call("/v1/definitions", { token: OTHER_OPERATOR })).json, []);
  for (const [method, path] of [["GET", `/v1/definitions/${id}`], ["PATCH", `/v1/definitions/${id}`], ["DELETE", `/v1/definitions/${id}`], ["GET", `/v1/definitions/${id}/agents`]]) {
    assert.equal((await r.call(path, { method, token: OTHER_OPERATOR, ...(method === "PATCH" ? { body: { name: "mine" } } : {}) })).status, 404, `${method} ${path}`);
  }
  assert.equal((await r.call("/v1/agents", { token: OTHER_OPERATOR, body: { definition: id } })).status, 404);

  const revised = await r.call(`/v1/definitions/${id}`, { method: "PATCH", body: { systemPrompt: "You are support, v2.", revision: 1 } });
  assert.equal(revised.status, 200, revised.text);
  assert.equal(revised.json.revision, 2);
  assert.deepEqual(revised.json.builtins, ["web_fetch"], "fields not given are kept");
  assert.equal((await r.call(`/v1/definitions/${id}`, { method: "PATCH", body: { name: "stale", revision: 1 } })).status, 409);
  const cleared = await r.call(`/v1/definitions/${id}`, { method: "PATCH", body: { builtins: null } });
  assert.equal(cleared.json.revision, 3);
  assert.equal("builtins" in cleared.json, false, "null removes a field");
  assert.equal((await r.call(`/v1/definitions/${id}`, { method: "PATCH", body: {} })).json.revision, 3, "an empty update changes nothing");
  assert.equal((await r.call(`/v1/definitions/${id}`)).json.systemPrompt, "You are support, v2.");
  assert.equal((await r.call(`/v1/definitions/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(`/v1/definitions/${id}`)).status, 404);
  assert.equal((await r.call("/v1/definitions")).json.length, 1);
});

contractTest("definitions", "tests/definitions.test.ts:53", "a definition's key upserts it: the same key is the same definition, revised only when it changes", async (t, _f) => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const key = { "Idempotency-Key": "researcher" };
  const first = await r.call("/v1/definitions", { body: { name: "Researcher", builtins: ["web_search"], systemPrompt: "Research." }, headers: key });
  assert.equal(first.status, 201, first.text);
  const again = await r.call("/v1/definitions", { body: { name: "Researcher", builtins: ["web_search"], systemPrompt: "Research." }, headers: key });
  assert.equal(again.json.id, first.json.id);
  assert.equal(again.json.revision, 1, "the same configuration changes nothing");
  const changed = (await r.call("/v1/definitions", { body: { name: "Researcher", builtins: ["web_search", "web_fetch"] }, headers: key })).json;
  assert.equal(changed.id, first.json.id);
  assert.equal(changed.revision, 2);
  assert.deepEqual(changed.builtins, ["web_search", "web_fetch"]);
  assert.equal(changed.systemPrompt, undefined, "an upsert sets the whole definition: fields left out are cleared");
  assert.equal((await r.call("/v1/definitions")).json.length, 1, "no duplicates");
  assert.equal((await r.call("/v1/definitions", { body: { name: "Researcher" }, headers: key, token: OTHER_OPERATOR })).json.id === first.json.id, false, "keys are per tenant");
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  assert.equal((await sdk.upsertDefinition("researcher", { name: "Researcher", builtins: ["web_search", "ask_user"] })).id, first.json.id);
  // Run limits are part of a definition the SDK makes, typed (no cast).
  const limited = await sdk.upsertDefinition("researcher", { name: "Researcher", runLimits: { maxResponses: 20, maxSeconds: 600 } });
  assert.deepEqual(limited.runLimits, { maxResponses: 20, maxSeconds: 600 });
});

contractTest("definitions", "tests/definitions.test.ts:75", "a definition's idle lifetime applies, and a lifetime given with the agent replaces it", async (t, _f) => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const definition = (await r.call("/v1/definitions", { body: { name: "Support", systemPrompt: "You are support.", limits: { ttlSeconds: 3600 } } })).json;
  const idle = (await r.call("/v1/agents", { body: { definition: definition.id, idleTtlSeconds: 600 } })).json;
  assert.ok(Math.abs(idle.expiresAt - (Date.now() + 600_000)) < 60_000, "the agent's idle lifetime applies");
  const idling = (await r.call("/v1/definitions", { body: { name: "Idle", limits: { idleTtlSeconds: 900 } } })).json;
  assert.ok(Math.abs((await r.call("/v1/agents", { body: { definition: idling.id } })).json.expiresAt - (Date.now() + 900_000)) < 60_000, "the definition's idle lifetime applies");
  assert.equal((await r.call("/v1/definitions", { body: { name: "x", limits: { ttlSeconds: 3600, idleTtlSeconds: 900 } } })).status, 400);
});

contractTest("definitions", "tests/definitions.test.ts:85", "agents are made from a definition, record its revision, and take a new one when it is applied", async (t, _f) => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const definition = (await r.call("/v1/definitions", { body: { name: "Support", systemPrompt: "You are support v1.", limits: { ttlSeconds: 3600 } } })).json;
  const created = await r.call("/v1/agents", { body: { definition: definition.id }, headers: { "Idempotency-Key": "first" } });
  assert.equal(created.status, 201, created.text);
  assert.ok(Math.abs(created.json.expiresAt - (Date.now() + 3_600_000)) < 60_000, "the definition's ttl applies");
  const first = created.json.id;
  let detail = (await r.call(`/v1/agents/${first}`)).json;
  assert.deepEqual(detail.definition, { id: definition.id, revision: 1 });
  assert.equal(detail.name, "Support");
  assert.equal(detail.systemPrompt, "You are support v1.");
  assert.deepEqual(detail.tools, [], "application tools come only from an attached server");
  assert.equal((await r.call("/v1/agents", { body: { definition: definition.id, systemPrompt: "x" } })).status, 400, "the prompt is the definition's");
  assert.equal((await r.call("/v1/agents", { body: { definition: "def_00000000000000000000" } })).status, 404);
  await r.prompt(first, "hello");
  assert.match(systemText(r.model.bodies.at(-1)), /You are support v1\./);

  await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { systemPrompt: "You are support v2." } });
  // The same idempotency key still names the same agent, whatever the definition's revision.
  assert.equal((await r.call("/v1/agents", { body: { definition: definition.id }, headers: { "Idempotency-Key": "first" } })).json.id, first);
  const second = (await r.call("/v1/agents", { body: { definition: definition.id, name: "Second", ttlSeconds: null } })).json;
  assert.equal(second.expiresAt, null);
  assert.equal((await r.call(`/v1/agents/${second.id}`)).json.systemPrompt, "You are support v2.");
  assert.equal((await r.call(`/v1/agents/${first}`)).json.systemPrompt, "You are support v1.", "existing agents keep their revision");
  assert.deepEqual((await r.call(`/v1/definitions/${definition.id}/agents`)).json, [{ id: first, revision: 1 }, { id: second.id, revision: 2 }].sort((a, b) => a.id.localeCompare(b.id)));

  // The agent's own credential cannot apply a definition: only the tenant can.
  const configure = await fetch(`${r.base}/clients/${first}/requests`, {
    method: "POST", headers: { Authorization: `Bearer ${created.json.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sneaky", method: "configure", params: { definition: { id: definition.id, revision: 2 } } }),
  });
  assert.equal(configure.status, 400);

  const applied = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { systemPrompt: "You are support v3.", apply: "all" } });
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.json.revision, 3);
  assert.deepEqual(applied.json.applied.map((entry: any) => entry.agent), [first, second.id].sort());
  assert.equal(applied.json.applied.some((entry: any) => entry.status === "failed"), false);
  await until(async () => (await r.call(`/v1/definitions/${definition.id}/agents`)).json.every((agent: any) => agent.revision === 3), "both agents to take revision 3");
  detail = (await r.call(`/v1/agents/${first}`)).json;
  assert.equal(detail.systemPrompt, "You are support v3.");
  assert.deepEqual(detail.definition, { id: definition.id, revision: 3 });
  await r.prompt(first, "again");
  assert.match(systemText(r.model.bodies.at(-1)), /You are support v3\./, "the running agent was reconfigured");

  // Applying again with nothing changed is a no-op per agent.
  assert.deepEqual((await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { apply: "all" } })).json.applied.map((entry: any) => entry.status), ["updated", "updated"]);
  // Deleting the definition leaves its agents as they are.
  assert.equal((await r.call(`/v1/definitions/${definition.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.prompt(first, "still here")).outcome.result.reply, "ok");
});

contractTest("definitions", "tests/definitions.test.ts:137", "a definition with applyOnUpdate reaches its live agents on every save that revises it, upserts included", async (t, _f) => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const key = { "Idempotency-Key": "builder" };
  const save = (systemPrompt: string, extra: object = {}) => r.call("/v1/definitions", { body: { name: "Builder", systemPrompt, applyOnUpdate: true, ...extra }, headers: key });
  const created = await save("You are builder v1.");
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.applyOnUpdate, true);
  assert.equal(created.json.applied, undefined, "a new definition has no agents to apply to");
  const agents = await Promise.all(["a", "b"].map(async name => (await r.call("/v1/agents", { body: { definition: created.json.id, name } })).json.id));
  await r.prompt(agents[0], "hello");

  // The same upsert again (a deploy that changed nothing) makes no revision and applies nothing.
  const same = await save("You are builder v1.");
  assert.equal(same.json.revision, 1);
  assert.equal(same.json.applied, undefined);

  // A changed upsert makes revision 2 and applies it, as PATCH with apply: "all" would.
  const changed = await save("You are builder v2.");
  assert.equal(changed.status, 201, changed.text);
  assert.equal(changed.json.revision, 2);
  assert.deepEqual(changed.json.applied.map((entry: any) => entry.agent), [...agents].sort());
  assert.equal(changed.json.applied.some((entry: any) => entry.status === "failed"), false);
  await until(async () => (await r.call(`/v1/definitions/${created.json.id}/agents`)).json.every((agent: any) => agent.revision === 2), "both agents to take revision 2");
  await r.prompt(agents[0], "again");
  assert.match(systemText(r.model.bodies.at(-1)), /You are builder v2\./, "the running agent was reconfigured");

  // A PATCH revises it too; turning applyOnUpdate off is saved without applying, and later saves reach new agents only.
  const patched = await r.call(`/v1/definitions/${created.json.id}`, { method: "PATCH", body: { systemPrompt: "You are builder v3." } });
  assert.equal(patched.json.applied.length, 2);
  // An apply can be queued: let both agents persist it before advancing the definition again.
  await until(async () => (await r.call(`/v1/definitions/${created.json.id}/agents`)).json.every((agent: any) => agent.revision === 3), "both agents to take revision 3");
  const off = await r.call(`/v1/definitions/${created.json.id}`, { method: "PATCH", body: { applyOnUpdate: null } });
  assert.equal(off.json.applyOnUpdate, undefined);
  assert.equal(off.json.applied, undefined);
  const later = await r.call(`/v1/definitions/${created.json.id}`, { method: "PATCH", body: { systemPrompt: "You are builder v5." } });
  assert.equal(later.json.applied, undefined);
  assert.equal((await r.call(`/v1/agents/${agents[1]}`)).json.systemPrompt, "You are builder v3.");
  assert.equal((await r.call("/v1/definitions", { body: { name: "x", applyOnUpdate: "yes" } })).status, 400);
});

contractTest("definitions", "tests/definitions.test.ts:177", "an agent's own model, thinking level and prompt addition survive applying its definition", async (t, _f) => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const definition = (await r.call("/v1/definitions", { body: { name: "Threads", systemPrompt: "You are camel v1.", thinkingLevel: "high" } })).json;
  const created = await r.call("/v1/agents", { body: { definition: definition.id, thinkingLevel: "off", systemPromptAppend: "Thread: thr_1" } });
  assert.equal(created.status, 201, created.text);
  const agent = created.json.id;
  const other = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  for (const body of [{ systemPromptAppend: 5 }, { systemPromptAppend: "x".repeat(32_001) }]) {
    assert.equal((await r.call("/v1/agents", { body: { definition: definition.id, ...body } })).status, 400, JSON.stringify(body));
  }
  await r.prompt(agent, "hello");
  assert.match(systemText(r.model.bodies.at(-1)), /You are camel v1\.\n\nThread: thr_1/);

  // A model configured directly is the agent's own too.
  const configured = await r.call(`/v1/agents/${agent}/configuration`, { method: "PATCH", body: { model: "openrouter/openai/gpt-6-luna" } });
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/${configured.json.id}`)).json.state === "completed", "the model change");
  await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { systemPrompt: "You are camel v2.", apply: "all" } });
  await until(async () => (await r.call(`/v1/definitions/${definition.id}/agents`)).json.every((entry: any) => entry.revision === 2), "the apply");
  let detail = (await r.call(`/v1/agents/${agent}`)).json;
  assert.equal(detail.systemPrompt, "You are camel v2.");
  assert.equal(detail.systemPromptAppend, "Thread: thr_1");
  assert.equal((await r.call(`/v1/agents/${other}`)).json.systemPromptAppend, undefined);

  // The addition can change with the conversation.
  await r.call(`/v1/agents/${other}/configuration`, { method: "PATCH", body: { requestId: "append", systemPromptAppend: "Thread: thr_2" } });
  await until(async () => (await r.call(`/v1/agents/${other}`)).json.systemPromptAppend === "Thread: thr_2", "the addition");
  await r.prompt(other, "hello");
  assert.match(systemText(r.model.bodies.at(-1)), /You are camel v2\.\n\nThread: thr_2/);

  // A new model in the definition reaches the agents that did not choose their own.
  await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { model: "openrouter/anthropic/claude-sonnet-5", apply: "all" } });
  await until(async () => (await r.call(`/v1/definitions/${definition.id}/agents`)).json.every((entry: any) => entry.revision === 3), "the second apply");
  detail = (await r.call(`/v1/agents/${agent}`)).json;
  assert.equal(detail.model, "openrouter/openai/gpt-6-luna");
  assert.equal(detail.systemPromptAppend, "Thread: thr_1");
  assert.equal((await r.call(`/v1/agents/${other}`)).json.model, "openrouter/anthropic/claude-sonnet-5");
  // Node-only stored thinking-level assertion remains in the source suite.
});

contractTest("definitions", "tests/definitions.test.ts:217", "fileTools: false leaves the model present_file, and the file tools to code", async (t, _f) => {
  const r = await runtime(t, (_body, index) => [
    toolCall("codemode", { code: "await tools.write({ path: '/workspace/notes.md', content: 'hi' }); return (await tools.read({ path: '/workspace/notes.md' })).content;" }),
  ][index] ?? { role: "assistant", content: "ok" });
  const direct = (body: any) => body.tools.map((tool: any) => tool.function.name).sort();
  const definition = (await r.call("/v1/definitions", { body: { name: "Own files", fileTools: false } })).json;
  assert.equal(definition.fileTools, false);
  assert.equal((await r.call("/v1/definitions", { body: { name: "x", fileTools: "no" } })).status, 400);
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.fileTools, false);
  await r.prompt(agent, "take notes");
  assert.deepEqual(direct(r.model.bodies[0]), ["codemode", "decide", "present_file"]);
  assert.match(toolResults(r.model.bodies[1]).at(-1), /Script completed[\s\S]*\nhi$/, "code calls the file tools the model is not offered");
  assert.match(systemText(r.model.bodies[0]), /Scripts read and write them with the file tools \(tools\.read, tools\.write, tools\.ls and so on\); the application's own tools may reach other files/);
  assert.doesNotMatch(systemText(r.model.bodies[0]), /The file tools \(read/);

  // Applying the definition without it brings the file tools back, but not to an agent that chose to go without.
  const own = (await r.call("/v1/agents", { body: { definition: definition.id, fileTools: false } })).json.id;
  await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { fileTools: null, apply: "all" } });
  await until(async () => (await r.call(`/v1/definitions/${definition.id}/agents`)).json.every((entry: any) => entry.revision === 2), "the apply");
  await r.prompt(agent, "again");
  assert.deepEqual(direct(r.model.bodies.at(-1)), ["codemode", "cp", "decide", "edit", "glob", "grep", "ls", "mv", "present_file", "read", "write"]);
  assert.match(systemText(r.model.bodies.at(-1)) + JSON.stringify(r.model.bodies.at(-1).messages), /The file tools \(read/);
  await r.prompt(own, "hello");
  assert.deepEqual(direct(r.model.bodies.at(-1)), ["codemode", "decide", "present_file"]);
});

contractTest("definitions", "tests/definitions.test.ts:244", "the SDK makes an agent from a definition with its attached server's tools, which survive an apply", async (t, _f) => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const definition = (await r.call("/v1/definitions", { body: { name: "Desk", systemPrompt: "v1" } })).json;
  const runtimeClient = new AgentRuntime({ url: r.base, apiKey: "fixture-operator-token-at-least-24-chars" });
  const tool = (description: string) => ({ description, input: { type: "object", properties: {} } as const, execute: async () => ({ ok: true }) });
  const agent = await runtimeClient.createAgent({ definition: definition.id, tools: { lookup: tool("App's lookup"), extra: tool("Something else") } });
  t.after(() => agent.close());
  const names = async () => (await r.call(`/v1/agents/${agent.session.id}`)).json.tools.map((entry: any) => [entry.name, entry.description]);
  assert.deepEqual(await names(), [["lookup", "App's lookup"], ["extra", "Something else"]]);
  assert.deepEqual((await r.call(`/v1/agents/${agent.session.id}`)).json.definition, { id: definition.id, revision: 1 });

  await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { systemPrompt: "v2", apply: "all" } });
  await until(async () => (await r.call(`/v1/agents/${agent.session.id}`)).json.definition.revision === 2, "the apply");
  assert.deepEqual(await names(), [["lookup", "App's lookup"], ["extra", "Something else"]]);
});

contractTest("definitions", "tests/definitions.test.ts:328", "public configuration waits between turns, preserves history, and reports validation and outcome", async (t, _f) => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok", delayMs: 500 }));
  const agent = (await r.call("/v1/agents", { body: { systemPrompt: "Before" } })).json.id;
  const path = `/v1/agents/${agent}/configuration`;
  assert.equal((await r.call(path, { method: "PATCH", token: OTHER_OPERATOR, body: { systemPrompt: "intrude" } })).status, 404);
  for (const body of [{}, { model: "missing/model" }, { apiKey: "never-accepted" }, { systemPrompt: "" }]) {
    assert.equal((await r.call(path, { method: "PATCH", body })).status, 400);
  }
  const keyless = await r.call(path, { method: "PATCH", body: { model: "anthropic/claude-sonnet-5" } });
  assert.equal(keyless.status, 400);
  assert.match(keyless.json.error, /No anthropic API key .* PUT \/v1\/providers\/anthropic\/key/);
  const turn = r.prompt(agent, "Keep this in history");
  await until(() => r.model.bodies.length === 1, "model starts");
  const configured = await r.call(path, { method: "PATCH", body: { requestId: "config-1", systemPrompt: "After" } });
  assert.equal(configured.status, 202, configured.text);
  assert.equal(configured.json.state, "running");
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.systemPrompt, "Before");
  await turn;
  await until(async () => (await r.call(`/v1/agents/${agent}`)).json.systemPrompt === "After", "configuration applied");
  // The header is written before the request's outcome is: wait for both.
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/config-1`)).json.state === "completed", "the configuration's outcome");
  const history = (await r.call(`/v1/agents/${agent}/history`)).json;
  assert.ok(JSON.stringify(history).includes("Keep this in history"));
  const retried = await r.call(path, { method: "PATCH", body: { requestId: "config-1", systemPrompt: "After" } });
  assert.equal(retried.json.state, "completed");
  assert.equal(retried.json.outcome.result.configured, true);
  assert.equal((await r.call(path, { method: "PATCH", body: { requestId: "config-1", systemPrompt: "Different" } })).status, 409);
  // A catalog model may be selected without making a live model request.
  const changed = await r.call(path, { method: "PATCH", body: { model: "openrouter/openai/gpt-6-luna" } });
  assert.equal(changed.status, 202, changed.text);
  const settled = await until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${changed.json.id}`)).json; return record.state === "completed" && record; }, "model change");
  assert.equal(settled.outcome.error, undefined);
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, "openrouter/openai/gpt-6-luna");
  assert.deepEqual((await r.call(`/v1/agents/${agent}/history`)).json, history);
});

contractTest("definitions", "tests/definitions.test.ts:390", "a tenant's definitions are capped by its limit (409 DEFINITIONS_LIMIT), and the ones no agent uses can be listed to delete", async (t, _f) => {
  // alice (of the tenants file) at AGENT_MAX_DEFINITIONS_PER_TENANT=3.
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { AGENT_MAX_DEFINITIONS_PER_TENANT: "3" });
  const ids: string[] = [];
  for (const name of ["a", "b", "c"]) ids.push((await r.call("/v1/definitions", { body: { name } })).json.id);
  const refused = await r.call("/v1/definitions", { body: { name: "d" } });
  assert.deepEqual([refused.status, refused.json.code, refused.json.limit], [409, "DEFINITIONS_LIMIT", 3], refused.text);
  assert.match(refused.json.error, /at most 3 definitions/);
  // An agent made from the first; the other two are unused, and deleting one makes room.
  assert.equal((await r.call("/v1/agents", { body: { definition: ids[0] } })).status, 201);
  assert.deepEqual((await r.call("/v1/definitions?unused=true")).json.map((definition: any) => definition.id), ids.slice(1));
  assert.equal((await r.call("/v1/definitions")).json.length, 3);
  assert.equal((await r.call(`/v1/definitions/${ids[1]}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call("/v1/definitions", { body: { name: "d" } })).status, 201);
});
