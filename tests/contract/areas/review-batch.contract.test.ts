import {contractTest, createContractFixture, until} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
import assert from "node:assert/strict";
async function runtime(t:T,respond:ModelReply):Promise<ContractFixture>{return createContractFixture(t,{respond});}

const byId = async (r: ContractFixture, agent: string, id: string) => (await r.call(`/v1/agents/${agent}/requests/${id}`)).json;
const ended = (r: ContractFixture, agent: string, id: string) => until(async () => { const record = await byId(r, agent, id); return record.state === "completed" && record; }, `${id} to end`);
const text = (message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("");

contractTest("messages", "tests/queue-batch.test.ts:145", "review: each prompt of a batch reaches the model with its own sender", async t => {
  const r = await runtime(t, (_body, index) => ({ role: "assistant", content: `answer ${index}`, ...(index === 0 ? { delayMs: 1_500 } : {}) }));
  const agent = (await r.call("/v1/agents", { body: { queue: { mode: "batch" } } })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "first", requestId: "turn-1" } });
  await until(() => r.model.bodies.length === 1, "the first turn's model call");
  // One actor (a channel acting for its owner), three people, each in their own thread.
  for (const [index, name] of ["Ann", "Bob", "Cid"].entries())
    await r.call(`/v1/agents/${agent}/prompt`, { body: { text: `message from ${name}`, requestId: `m-${index}`, actor: "channel-owner", from: { id: `u-${name}`, name, thread: `thread-${name}` } } });
  const lead = await ended(r, agent, "m-0");
  assert.deepEqual(lead.batch, ["m-1", "m-2"]);
  const users = r.model.bodies[1].messages.filter((message: any) => message.role === "user").slice(1).map(text);
  console.log(JSON.stringify({ type: "review_batch_users", users }));
  for (const [index, name] of ["Ann", "Bob", "Cid"].entries()) {
    assert.match(users[index], new RegExp(`message from ${name}`));
    assert.match(users[index], new RegExp(`thread-${name}`), `message ${index} rendered with its own sender: ${users[index]}`);
  }
});

contractTest("delegation", "tests/queue-batch.test.ts:163", "review: a parent's delegate call to a named agent whose queue batches gets that agent's answer", async t => {
  const system = (body: any) => JSON.stringify(body.messages.filter((message: any) => message.role === "system" || message.role === "developer"));
  const users = (body: any) => body.messages.filter((message: any) => message.role === "user").map(text);
  const tools = (body: any) => body.messages.filter((message: any) => message.role === "tool").map(text);
  const r = await runtime(t, body => {
    if (system(body).includes("You are SPEC")) {
      const said = users(body).at(-1) ?? "";
      return { role: "assistant", content: `spec read: ${users(body).slice(1).join(" + ")}`, ...(said.includes("slow") ? { delayMs: 4_000 } : {}) };
    }
    if (body.messages.at(-1).role === "tool") return { role: "assistant", content: `parent got: ${tools(body).at(-1)}` };
    return { role: "assistant", tool_calls: [{ index: 0, id: "call_delegate", type: "function", function: { name: "delegate", arguments: JSON.stringify({ agent: "spec", task: "what is 2+2" }) } }] };
  });
  const spec = (await r.call("/v1/agents", { headers: { "Idempotency-Key": "spec" }, body: { systemPrompt: "You are SPEC.", queue: { mode: "batch" } } })).json.id as string;
  await r.call(`/v1/agents/${spec}/prompt`, { body: { text: "slow warm-up", requestId: "warm" } });
  await until(() => r.model.bodies.length === 1, "the specialist's first turn");
  await r.call(`/v1/agents/${spec}/prompt`, { body: { text: "an API question", requestId: "api-q" } });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["delegate"], delegate: { agents: [{ agent: "spec" }] } } })).json.id as string;
  await r.call(`/v1/agents/${parent}/prompt`, { body: { text: "go", requestId: "parent-go" } });
  const done = await ended(r, parent, "parent-go");
  const specRequests = (await r.call(`/v1/agents/${spec}`)).json.requests.map((request: any) => ({ id: request.id, batchedInto: request.batchedInto, batch: request.batch }));
  console.log(JSON.stringify({ type: "review_delegate", reply: done.outcome.result.reply, specRequests }));
  assert.match(done.outcome.result.reply, /spec read: .*what is 2\+2/, "the delegate call carries the specialist's answer");
});
