import {contractTest, createContractFixture} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
async function runtime(t:T,respond:ModelReply,env:Record<string,string>={},tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

import {Client} from "@modelcontextprotocol/sdk/client/index.js";

import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {ElicitRequestSchema} from "@modelcontextprotocol/sdk/types.js";

import {OPERATOR, lastUser, toolCall, toolResults, until} from "../support.ts";

type Runtime = Awaited<ReturnType<typeof runtime>>;

async function connect(t: { after(fn: () => unknown): void }, r: Runtime, agent: string, token: string, elicit?: (request: any) => object) {
  const client = new Client({ name: "test", version: "1" }, elicit ? { capabilities: { elicitation: { form: {} } } } : {});
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async request => elicit(request) as any);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${r.base}/v1/agents/${agent}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const progress: { progress: number; message?: string }[] = [];
  const message = async (text: string, requestId?: string) => {
    const result: any = await client.callTool({ name: "message", arguments: { text, ...(requestId ? { requestId } : {}) } }, undefined, { onprogress: update => progress.push(update), resetTimeoutOnProgress: true });
    return { isError: !!result.isError, text: result.content[0].text as string, structured: result.structuredContent };
  };
  return { client, message, progress };
}

async function agent(r: Runtime, body: object = { name: "Echo", systemPrompt: "You repeat what you are told.\n\nNever add anything." }) {
  const created = await r.call("/v1/agents", { body: { ttlSeconds: null, ...body } });
  assert.equal(created.status, 201, created.text);
  return created.json as { id: string; token: string };
}

const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };

contractTest("agents", "tests/agent-mcp.test.ts:87", "a message streams progress, is sent once when called again, and a full queue is busy", async t => {
  let hold = 0;
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}`, ...(lastUser(body) === "hold" ? { delayMs: hold } : {}) }));
  const echo = await agent(r);
  const { message, progress } = await connect(t, r, echo.id, OPERATOR);

  const reply = await message("stream me");
  assert.equal(reply.text, "echo: stream me");
  assert.ok(progress.some(update => update.message?.includes("echo: stream me")), JSON.stringify(progress));
  assert.ok(progress.every((update, index) => index === 0 || update.progress > progress[index - 1].progress), "progress only increases");

  // The same requestId is the same message: one model call, the same reply.
  const calls = r.model.bodies.length;
  assert.equal((await message("once", "mcp-once")).text, "echo: once");
  assert.equal((await message("once", "mcp-once")).text, "echo: once");
  assert.equal(r.model.bodies.length, calls + 1);

  // Without a requestId, a call sent again (same session and JSON-RPC id) is the same message too.
  const post = (session: string | undefined, body: object) => fetch(`${r.base}/v1/agents/${echo.id}/mcp`, { method: "POST", headers: {
    Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...(session ? { "Mcp-Session-Id": session } : {}),
  }, body: JSON.stringify(body) });
  const initialized = await post(undefined, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
  const session = initialized.headers.get("mcp-session-id")!;
  assert.ok(session, "a session id carries what the client can do");
  const send = async () => {
    const answer = await (await post(session, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "message", arguments: { text: "raw" } } })).text();
    const data = answer.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(entry => entry.id === 7);
    return data.result.content[0].text;
  };
  const before = r.model.bodies.length;
  assert.equal(await send(), "echo: raw");
  assert.equal(await send(), "echo: raw");
  assert.equal(r.model.bodies.length, before + 1);

  // As with the prompt API, messages queue behind a running turn, up to the agent's limit: past it, the agent is busy.
  hold = 5_000;
  const held = await r.call(`/v1/agents/${echo.id}/prompt`, { body: { text: "hold" } });
  await until(async () => (await r.call(`/v1/agents/${echo.id}/requests/${held.json.id}`)).json.began, "the held turn to begin");
  const queued = [held, ...await Promise.all(Array.from({ length: 31 }, (_, index) => r.call(`/v1/agents/${echo.id}/prompt`, { body: { text: `queued ${index}` } })))];
  assert.ok(queued.every(entry => entry.status === 202), queued.map(entry => entry.text).join());
  const busy = await message("one more");
  assert.equal(busy.isError, true);
  assert.match(busy.text, /^The agent is busy: Too many requests queued/);
  assert.equal((await r.call(`/v1/agents/${echo.id}`, { method: "DELETE" })).status, 200, "rather than wait for the queue at shutdown");
});

contractTest("agents", "tests/agent-mcp.test.ts:135", "a turn waiting on a person asks through the client, or says how to answer", async t => {
  // Asked anything, the model asks which region; told the answer, it deploys there.
  const r = await runtime(t, (body, index) => {
    if (body.messages.at(-1).role !== "tool") return toolCall("ask_user", ASK, `call_ask_${index}`);
    const result = toolResults(body).at(-1);
    return { role: "assistant", content: result.startsWith("{") ? `Deploying to ${JSON.parse(result).answers["Which region?"]}` : "Not deploying" };
  });
  const definition = (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] } })).json;
  const asker = await agent(r, { definition: definition.id });

  // A client that can ask: the question comes as an elicitation, and its answer resumes the turn.
  const asked: any[] = [];
  const eliciting = await connect(t, r, asker.id, OPERATOR, request => { asked.push(request.params); return { action: "accept", content: { q1: "US" } }; });
  const reply = await eliciting.message("Deploy it");
  assert.deepEqual([reply.isError, reply.text], [false, "Deploying to US"]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, "Which region?");
  assert.deepEqual(asked[0].requestedSchema.properties.q1.enum, ["EU", "US"]);
  assert.ok(eliciting.progress.some(update => update.message === "Using ask_user"));

  // One that cannot: the call ends saying what the agent waits on and how to answer; the same call again gives the reply.
  const plain = await connect(t, r, asker.id, asker.token);
  const waiting = await plain.message("Deploy again", "deploy-2");
  assert.equal(waiting.isError, false);
  assert.equal(waiting.structured.status, "input_required");
  assert.match(waiting.text, /waiting for a person's input[\s\S]*Which region\? \(EU, US\)[\s\S]*requestId "deploy-2"/);
  const [input] = waiting.structured.inputs;
  const answered = await r.call(`/v1/agents/${asker.id}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } } } });
  assert.equal(answered.status, 202, answered.text);
  assert.equal((await plain.message("Deploy again", "deploy-2")).text, "Deploying to EU");

  // An answer whose call is gone (or on another node) still answers the input it names.
  const orphan = await plain.message("Deploy once more", "deploy-3");
  const reply3 = await fetch(`${r.base}/v1/agents/${asker.id}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `input:${orphan.structured.inputs[0].id}`, result: { action: "accept", content: { q1: "US" } } }) });
  assert.equal(reply3.status, 202);
  assert.equal((await plain.message("Deploy once more", "deploy-3")).text, "Deploying to US");

  // Declining in the client declines the input: the model is told, and replies.
  const declining = await connect(t, r, asker.id, OPERATOR, () => ({ action: "decline" }));
  const declined = await declining.message("Deploy a third time");
  assert.deepEqual([declined.isError, declined.text], [false, "Not deploying"]);
  await until(async () => (await r.call(`/v1/agents/${asker.id}/inputs?state=declined`)).json.length === 1, "the declined input");
});

import {createHash, randomBytes} from "node:crypto";
import {OTHER_OPERATOR} from "../support.ts";
const PUBLIC = "https://agents.example.test";

/** Obtain the same tenant OAuth credential through the public password, consent and token endpoints. */
async function oauthToken(r: ContractFixture, clientId: string, agentId: string): Promise<string> {
  const password = "contract-oauth-password-123";
  const saved = await r.call("/v1/tenants/alice/password", {method:"PUT", body:{email:"alice@example.test",password}});
  if(saved.status !== 200) throw new Error(`OAuth setup password failed: ${saved.status}`);
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({response_type:"code",client_id:clientId,redirect_uri:"http://127.0.0.1:43210/cb",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256",resource:`${PUBLIC}/v1/agents/${agentId}/mcp`});
  const post = (path:string, body:Record<string,string>, headers:Record<string,string>={}) => fetch(r.base+path,{method:"POST",redirect:"manual",headers:{"Content-Type":"application/x-www-form-urlencoded",...headers},body:new URLSearchParams(body)});
  const login = await post("/oauth/password",{email:"alice@example.test",password,next:`/oauth/authorize?${query}`},{Origin:r.base});
  if(login.status !== 303) throw new Error(`OAuth setup login failed: ${login.status}`);
  const cookie=login.headers.get("set-cookie")!.split(";")[0];
  const allowed=await post("/oauth/authorize",{...Object.fromEntries(query),decision:"allow"},{Cookie:cookie,Origin:r.base});
  if(allowed.status !== 302) throw new Error(`OAuth setup consent failed: ${allowed.status}`);
  const code=new URL(allowed.headers.get("location")!).searchParams.get("code")!;
  const issued=await post("/oauth/token",{client_id:clientId,grant_type:"authorization_code",code,redirect_uri:"http://127.0.0.1:43210/cb",code_verifier:verifier});
  if(issued.status !== 200) throw new Error(`OAuth setup exchange failed: ${issued.status}`);
  return (await issued.json()).access_token;
}

contractTest("agents", "tests/agent-mcp.test.ts:33","an agent's MCP endpoint takes whatever may prompt it, and no other tenant's token",async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}` }));
  const echo = await agent(r), other = await agent(r, { name: "Other" });
  const url = `${r.base}/v1/agents/${echo.id}/mcp`;
  const list = { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) };

  const anonymous = await fetch(url, list);
  assert.equal(anonymous.status, 401);
  const metadata = `${PUBLIC}/.well-known/oauth-protected-resource/v1/agents/${echo.id}/mcp`;
  assert.match(anonymous.headers.get("www-authenticate")!, new RegExp(`^Bearer resource_metadata="${metadata.replaceAll(".", "\\.")}"`));
  const resource = await (await fetch(`${r.base}/.well-known/oauth-protected-resource/v1/agents/${echo.id}/mcp`)).json();
  assert.deepEqual([resource.resource, resource.authorization_servers], [`${PUBLIC}/v1/agents/${echo.id}/mcp`, [PUBLIC]]);
  // Clients sign in for the agent's endpoint as a resource of its own.
  const registered = await (await fetch(`${r.base}/oauth/register`, { method: "POST", body: JSON.stringify({ client_name: "Test", redirect_uris: ["http://127.0.0.1:43210/cb"], token_endpoint_auth_method: "none" }) })).json();
  const authorize = (target: string) => fetch(`${r.base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: "http://127.0.0.1:43210/cb",
    code_challenge: randomBytes(32).toString("base64url"), code_challenge_method: "S256", resource: target })}`, { redirect: "manual" });
  assert.equal((await authorize(`${PUBLIC}/v1/agents/${echo.id}/mcp`)).status, 200, "the sign-in page");
  assert.match((await authorize(`${PUBLIC}/v1/agents/${echo.id}/other`)).headers.get("location")!, /error=invalid_target/);
  const bad = await fetch(url, { ...list, headers: { ...list.headers, Authorization: "Bearer art_nope" } });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate")!, /error="invalid_token"/);
  assert.equal((await fetch(url, { ...list, headers: { ...list.headers, Authorization: `Bearer ${other.token}` } })).status, 401, "another agent's token");
  assert.equal((await fetch(url, { ...list, headers: { ...list.headers, Authorization: `Bearer ${OTHER_OPERATOR}` } })).status, 404, "another tenant's");

  // An OAuth access token for the tenant, as a client that signed in holds.
  const oauth = await oauthToken(r, registered.client_id, echo.id);

  for (const token of [echo.token, OPERATOR, oauth]) {
    const { client, message } = await connect(t, r, echo.id, token);
    const [tool] = (await client.listTools()).tools;
    assert.equal(tool.name, "message");
    assert.match(tool.description!, /^Send a message to the agent "Echo" and get its reply\./);
    assert.doesNotMatch(tool.description!, /repeat/, "never its system prompt");
    const reply = await message(`hi via ${token.slice(0, 4)}`);
    assert.deepEqual([reply.isError, reply.text], [false, `echo: hi via ${token.slice(0, 4)}`]);
  }
  // A definition's description says what its agents are for; a change to it shows at once.
  const definition = (await r.call("/v1/definitions", { body: { name: "Support", description: "Answers questions about orders and refunds.", systemPrompt: "Secret instructions." } })).json;
  const support = await agent(r, { definition: definition.id });
  const described = async () => (await (await connect(t, r, support.id, OPERATOR)).client.listTools()).tools[0].description!;
  assert.match(await described(), /^Send a message to the agent "Support" and get its reply\.\n\nAnswers questions about orders and refunds\./);
  assert.doesNotMatch(await described(), /Secret/);
  assert.equal((await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { description: "Tracks parcels." } })).status, 200);
  assert.match(await described(), /\n\nTracks parcels\.\n/);
  assert.equal((await r.call("/v1/definitions", { body: { name: "Bad", description: " " } })).status, 400);

  // The messages went into the agent's one history, as prompts do.
  const history = (await r.call(`/v1/agents/${echo.id}/history`)).json.messages;
  assert.equal(history.filter((entry: any) => entry.role === "user").length, 3);
  assert.equal((await r.call(`/v1/agents/${other.id}/history`)).json.messages.length, 0);
});
