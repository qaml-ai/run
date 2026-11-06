import { contractTest, createContractFixture, toolCall, toolResults, listen, until, type T } from '../support.ts';
import { createHash } from "node:crypto";
import type { ModelReply, ContractFixture } from '../fixture.ts';
async function runtime(t:T, respond:ModelReply, env:Record<string,string>={}, tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

/**
 * Not a port: a case of this contract's own (ECS behavior from #625, checked on both backends). Once a call from code
 * waits on a person, the script's later calls are held until the answer; an input closed without one ends the script,
 * and the held calls are never made.
 */
const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const ASK = { questions: [{ question: "Delete prod?", header: "Delete", options: [{ label: "Yes" }, { label: "No" }] }] };

/** An MCP server whose `read` answers after `delayMs`, so the script's next call comes after the question was asked. */
async function server(t: T, delayMs: number) {
  const calls: string[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const message = JSON.parse(text);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (result: object) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "held", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: ["read", "wipe"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } })) });
    if (message.method === "tools/call") {
      calls.push(message.params.name);
      if (message.params.name === "read") await new Promise(resolve => setTimeout(resolve, delayMs));
      return reply({ content: [{ type: "text", text: `${message.params.name} done` }] });
    }
    reply({});
  });
  return { url: `${url}/mcp`, calls };
}

contractTest("human-input", "tests/contract/areas/codemode-held-calls.contract.test.ts:1", "a call a script makes while another waits on a person is held, and never made when the input closes unanswered", async (t)=>{
  const s = await server(t, 500);
  const script = `const asking = tools.ask_user(${JSON.stringify(ASK)});
await tools.s__read({});
const wiping = tools.s__wipe({});
return [await asking, await wiping];`;
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("codemode", { code: script }, "code") : { role: "assistant", content: `after: ${toolResults(body).length}` }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Held", builtins: ["ask_user"], humanInput: {}, mcpServers: [{ name: "s", url: s.url, exposure: "codemode" }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;

  const suspended = await r.prompt(agent, "Clean up");
  assert.equal(suspended.outcome.result.stopped, "input_required");
  const [question] = suspended.outcome.result.inputs;
  assert.deepEqual([question.kind, question.toolCallId], ["question", "code/c1"]);
  assert.deepEqual(s.calls, ["read"], "the call made after the question waits for its answer");

  // A new message instead of the answer: the question closes unanswered, the script ends, and the held call never runs.
  const next = await r.prompt(agent, "never mind");
  assert.equal(next.outcome.error, undefined, JSON.stringify(next.outcome));
  assert.notEqual((await r.call(`/v1/agents/${agent}/inputs`)).json.find((input: any) => input.id === question.id)?.state, "pending");
  assert.deepEqual(s.calls, ["read"], "the held call was never made");
});

contractTest("human-input", "tests/contract/areas/codemode-held-calls.contract.test.ts:2", "a call held while another waits on a person is made once no one answers in time and the runtime answers instead", async (t)=>{
  const s = await server(t, 500);
  const script = `const asking = tools.ask_user(${JSON.stringify(ASK)});
await tools.s__read({});
const wiping = tools.s__wipe({});
return [await asking, await wiping];`;
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("codemode", { code: script }, "code") : { role: "assistant", content: toolResults(body).at(-1) }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Held", builtins: ["ask_user"], humanInput: {}, mcpServers: [{ name: "s", url: s.url, exposure: "codemode" }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;

  const suspended = await r.prompt(agent, "Clean up");
  assert.equal(suspended.outcome.result.stopped, "input_required");
  const [question] = suspended.outcome.result.inputs;
  assert.deepEqual(s.calls, ["read"], "the call made after the question waits for its answer");

  // No one answers in time: the question gets the runtime's answer, and the held call is made, as after a person's.
  await r.expireInputs(agent);
  const resume = `resume_${createHash("sha256").update(question.requestId).digest("hex").slice(0, 40)}`;
  const resumed = await until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${resume}`)).json; return record?.state === "completed" && record; }, "the resumed run", 15_000, { pendingResources: [`/v1/agents/${agent}/requests/${resume}`] });
  assert.equal(resumed.outcome.error, undefined, JSON.stringify(resumed.outcome));
  assert.equal((await r.call(`/v1/agents/${agent}/inputs`)).json.find((input: any) => input.id === question.id)?.state, "expired");
  assert.deepEqual(s.calls, ["read", "wipe"], "the held call was made once");
  assert.match(resumed.outcome.result.reply, /"timedOut":true[\s\S]*wipe done/);
  assert.equal(r.model.bodies.length, 2, "the model is asked only to start and to answer");
});
