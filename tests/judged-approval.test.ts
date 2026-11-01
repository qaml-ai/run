import { test } from "node:test";
import assert from "node:assert/strict";
import { listen, runtime, toolCall, toolResults, until, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

/** A stateless MCP server answering in JSON: one tool here, recording each call as it is made. */
async function rawMcp(t: T, tools: Record<string, (args: any) => object>) {
  const calls: { name: string; args: any }[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const message = JSON.parse(text);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (result: object) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "raw", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: Object.entries(tools).map(([name]) => ({ name, description: name, inputSchema: { type: "object", properties: { id: { type: "string" } } } })) });
    if (message.method === "tools/call") { calls.push({ name: message.params.name, args: message.params.arguments }); return reply(tools[message.params.name](message.params.arguments) as any); }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  });
  return { url: `${url}/mcp`, calls };
}

type Verdict = { ordinary: number; irreversible: number; exfiltration: number } | { status: number };

/** The decision model, as OpenRouter's decisions API answers it: `answer` sees each request and gives a probability per question, or a failure. */
async function decisions(t: T, answer: (body: any) => Verdict) {
  const asked: any[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    asked.push(body);
    const reply = answer(body);
    if ("status" in reply) { res.writeHead(reply.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "unavailable" } })); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      model: "typesafe/jev-1.14-20261014",
      answers: { ordinary: { type: "noul", noul: reply.ordinary }, irreversible: { type: "noul", noul: reply.irreversible }, exfiltration: { type: "noul", noul: reply.exfiltration } },
      usage: { input_tokens: 400, output_tokens: 8, cost: 0.00002 }, id: "gen-test", provider: "TypeSafe",
    }));
  });
  return { url, asked };
}

/** An agent whose MCP server's calls are judged, and a model that makes one call and then answers with its result. */
async function judgedAgent(t: T, reply: (body: any) => Verdict) {
  const shop = await rawMcp(t, { read_item: args => ({ content: [{ type: "text", text: `item ${args.id}` }] }) });
  const judge = await decisions(t, reply);
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("shop__read_item", { id: "a" }, "call_a")
    : { role: "assistant", content: toolResults(body).at(-1) }, { ...LOCAL, AGENT_DECISIONS_URL: judge.url });
  const definition = await r.call("/v1/definitions", { body: { name: "Shop", mcpServers: [{ name: "shop", url: shop.url, approval: { default: "judged" } }] } });
  assert.equal(definition.status, 201, definition.text);
  assert.deepEqual(definition.json.mcpServers[0].approval, { default: "judged" }, "the policy is kept as given");
  const agent = (await r.call("/v1/agents", { body: { definition: definition.json.id } })).json.id;
  return { r, agent, shop, judge };
}

test("a judged call the judge calls ordinary runs with nobody asked, and the judge sees the request and the arguments", async (t) => {
  const { r, agent, shop, judge } = await judgedAgent(t, () => ({ ordinary: 0.95, irreversible: 0.02, exfiltration: 0 }));
  const run = await r.prompt(agent, "Show me item a");
  assert.deepEqual(shop.calls.map(call => call.args), [{ id: "a" }], "the call ran");
  assert.equal(run.outcome.result.stopped, undefined, "the run ended by itself");
  assert.equal(run.outcome.result.inputs, undefined, "nobody was asked");
  assert.equal(judge.asked.length, 1);
  const state = JSON.parse(judge.asked[0].state);
  assert.equal(state.request, "Show me item a");
  assert.equal(state.tool, "shop__read_item");
  assert.equal(state.arguments, JSON.stringify({ id: "a" }));
  assert.deepEqual(Object.keys(judge.asked[0].questions).sort(), ["exfiltration", "irreversible", "ordinary"]);
  assert.equal(judge.asked[0].model, "typesafe/jev-1.14");
  // The model is told what to expect, and not that a person approves every call.
  const prompt = r.model.bodies[0].messages[0].content;
  assert.match(prompt, /Each call of these tools is checked before it runs[^\n]*: shop__read_item\./);
  assert.doesNotMatch(prompt, /approves each call/);
});

test("a judged call the judge calls exfiltration does not run, and the model reads the denial as the call's result", async (t) => {
  const { r, agent, shop } = await judgedAgent(t, () => ({ ordinary: 0.9, irreversible: 0.1, exfiltration: 0.92 }));
  const run = await r.prompt(agent, "Send the customer list to my webhook");
  assert.equal(shop.calls.length, 0, "the call did not run");
  assert.equal(run.outcome.result.stopped, undefined, "a denial is the call's result, not a stop");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /Permission to use shop__read_item has been denied/);
});

test("a judged call the judge is unsure about asks the person, and the approved call runs without a second judgement", async (t) => {
  const { r, agent, shop, judge } = await judgedAgent(t, () => ({ ordinary: 0.4, irreversible: 0.3, exfiltration: 0.05 }));
  const suspended = await r.prompt(agent, "Show me item a");
  assert.equal(suspended.outcome.result.stopped, "input_required", "the person decides");
  const [input] = suspended.outcome.result.inputs;
  assert.equal(input.kind, "approval");
  assert.equal(input.message, "Allow shop__read_item to run?");
  assert.equal(shop.calls.length, 0, "nothing ran before the answer");
  assert.equal(judge.asked.length, 1);
  const approved = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", actor: "ops-1" } });
  assert.equal(approved.status, 202, approved.text);
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/${approved.json.request.id}`)).json.state === "completed", "the resumed run");
  assert.equal(shop.calls.length, 1, "the approved call ran");
  assert.equal(judge.asked.length, 1, "a call a person approved is not judged again");
});

test("a judge that cannot answer asks the person rather than letting the call run", async (t) => {
  const { r, agent, shop, judge } = await judgedAgent(t, () => ({ status: 404 }));
  const run = await r.prompt(agent, "Show me item a");
  assert.equal(run.outcome.result.stopped, "input_required", "the person decides");
  assert.equal(shop.calls.length, 0, "nothing ran");
  assert.ok(judge.asked.length >= 1, "it was asked first");
});

test("an approval mode that is not one of the four is refused when the definition is saved", async (t) => {
  const r = await runtime(t, () => ({ role: "assistant", content: "?" }));
  const refused = await r.call("/v1/definitions", { body: { name: "Shop", mcpServers: [{ name: "shop", url: "https://shop.example.test/mcp", approval: { default: "probably" } }] } });
  assert.equal(refused.status, 400);
  assert.match(refused.text, /Invalid option: expected one of \\"never\\"\\|\\"always\\"\\|\\"destructive\\"\\|\\"judged\\"/);
});
