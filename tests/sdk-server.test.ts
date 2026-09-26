import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AgentRuntime, nodeListener, schema, tool, type ToolContext } from "../clients/node.ts";
import { RuntimeTokenError, runtimeAuth, runtimeIdentity, serveTools, verifyRuntimeToken } from "../clients/server.ts";
import { testRuntime } from "../clients/testing.ts";
import { OPERATOR, runtime, toolCall, toolResults, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const APP = "https://app.test/mcp";

/** A team's to-dos, scoped to whoever the runtime says is asking. */
function todoTools(todos: { owner: string; team: string; text: string }[]) {
  return {
    list_todos: tool({
      description: "The current user's to-dos", input: schema.Object({}),
      execute: (_args, { identity }) => ({ todos: todos.filter(todo => todo.owner === identity!.user && todo.team === identity!.context.team).map(todo => todo.text) }),
    }),
    whoami: tool({ description: "Who is asking", input: schema.Object({}), execute: (_args, context: ToolContext) => ({ ...context.identity, origin: context.origin }) }),
  };
}
const todos = [{ owner: "alice", team: "acme", text: "ship it" }, { owner: "bob", team: "acme", text: "review it" }, { owner: "alice", team: "other", text: "not this team" }];

test("serveTools answers each call as the user the runtime's token names, and refuses anything else", async () => {
  const rt = await testRuntime();
  const handler = serveTools(todoTools(todos), rt.options);
  const list = async (who: Parameters<typeof rt.callTool>[4]) => (await rt.callTool(handler, APP, "list_todos", {}, who)).structuredContent;
  assert.deepEqual(await list({ subject: "alice", context: { team: "acme" } }), { todos: ["ship it"] });
  assert.deepEqual(await list({ subject: "team-acme", actor: "bob", context: { team: "acme" } }), { todos: ["review it"] }, "the actor, not the agent's subject");
  const me = (await rt.callTool(handler, APP, "whoami", {}, { subject: "alice", actor: "bob", tenant: "t1", agent: "client_1", definition: "def_1", context: { team: "acme" }, origin: { channel: "slack" } })).structuredContent;
  assert.deepEqual(me, { user: "bob", subject: "alice", actor: "bob", tenant: "t1", agent: "client_1", definition: "def_1", context: { team: "acme" }, origin: { channel: "slack" } });

  // MCP over stateless HTTP: initialize, tools/list, batches, notifications.
  const post = async (message: unknown, who: Parameters<typeof rt.request>[2] = {}) => handler(await rt.request(APP, message, who));
  const init = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json() as any;
  assert.deepEqual([init.result.protocolVersion, init.result.capabilities], ["2025-06-18", { tools: {} }]);
  const batch = await (await post([{ jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 3, method: "nope" }])).json() as any[];
  assert.deepEqual(batch.map(reply => reply.id), [2, 3]);
  assert.deepEqual(batch[0].result.tools.map((entry: any) => entry.name), ["list_todos", "whoami"]);
  assert.equal(batch[1].error.code, -32601);
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

  // Refusals: no token, another server's, expired, another key's, another issuer's, not EdDSA.
  const refused = async (request: Request) => {
    const response = await handler(request);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate")!, /^Bearer error="invalid_token", resource_metadata="https:\/\/app\.test\/\.well-known\/oauth-protected-resource\/mcp"$/);
    return (await response.json() as any).error;
  };
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_todos", arguments: {} } };
  assert.equal(await refused(await rt.request(APP, call, null)), "No bearer token");
  const withToken = (token: string) => new Request(APP, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(call) });
  assert.equal(await refused(withToken(await rt.token({ subject: "alice" }, "https://other.test/mcp"))), "Token is for another server");
  assert.equal(await refused(withToken(await rt.token({ subject: "alice" }, APP, { expiresIn: -120 }))), "Token has expired");
  const stranger = await testRuntime();
  assert.equal(await refused(withToken(await stranger.token({ subject: "alice" }, APP))), "Token signed with a key the runtime does not publish");
  const forged = await rt.token({ subject: "alice" }, APP);
  const [head, body] = forged.split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(await refused(withToken(`${head}.${Buffer.from(JSON.stringify({ ...claims, sub: "bob" })).toString("base64url")}.${forged.split(".")[2]}`)), "Token signature does not verify");
  assert.equal(await refused(withToken(await rt.token({ subject: "alice" }, APP, { claims: { iss: "https://evil.test" } }))), "Token is from another issuer");
  assert.equal(await refused(withToken(await rt.token({ subject: "alice" }, APP, { header: { alg: "none" } }))), "Token is not an EdDSA token with a key id");
  assert.equal(await refused(withToken("not-a-token")), "Malformed token");

  // MCP's protected-resource metadata names the runtime; only POST speaks MCP.
  const metadata = await handler(new Request("https://app.test/.well-known/oauth-protected-resource/mcp"));
  assert.deepEqual(await metadata.json(), { resource: APP, authorization_servers: [rt.url], bearer_methods_supported: ["header"], resource_name: "agent-runtime tools" });
  assert.equal((await handler(new Request(APP))).status, 405);
});

test("runtimeAuth gives MCP SDK servers the same identity; verifyRuntimeToken checks tokens directly", async () => {
  const rt = await testRuntime();
  const request = await rt.request(APP, {}, { subject: "alice", context: { team: "acme" } });
  const auth = await runtimeAuth(request, rt.options);
  assert.equal(runtimeIdentity({ authInfo: auth })!.user, "alice");
  assert.equal(auth.clientId, "client_test");
  const identity = await verifyRuntimeToken(await rt.token({ actor: "bob" }, "https://app.test/mcp/"), { ...rt.options, audience: APP });
  assert.equal(identity.user, "bob", "a trailing slash on either side still matches");
  await assert.rejects(runtimeAuth(new Request(APP), rt.options), RuntimeTokenError);
});

test("through a real runtime: served tools get its signed identity, attached tools the same identity from the call", async t => {
  let base = "";
  const r = await runtime(t, body => {
    const last = body.messages.at(-1);
    if (last.role === "tool") return { role: "assistant", content: "done" };
    const direct = body.tools.map((entry: any) => entry.function.name).find((name: string) => name.endsWith("whoami"));
    return toolCall(direct, {});
  }, { ...LOCAL, AGENT_PUBLIC_URL: "" });
  base = r.base;
  // The application's server, trusting only the runtime at `base`.
  const server = createServer(nodeListener(serveTools(todoTools(todos), { runtime: base })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const app = `http://127.0.0.1:${(server.address() as any).port}/mcp`;

  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const definition = await sdk.createDefinition({ name: "Todos", mcpServers: [{ name: "todos", url: app, auth: { type: "runtime" }, exposure: "both" }] });
  const served = await r.call("/v1/agents", { body: { definition: definition.id, subject: "team-acme", context: { team: "acme" } } });
  await r.prompt(served.json.id, "who am i?");
  const fromServer = JSON.parse(toolResults(r.model.bodies.at(-1)).at(-1));
  assert.deepEqual([fromServer.user, fromServer.subject, fromServer.tenant, fromServer.agent, fromServer.definition, fromServer.context], ["team-acme", "team-acme", "alice", served.json.id, definition.id, { team: "acme" }]);

  // Attached: the same tool definitions, over the agent's connection; the runtime sends the identity with the call.
  const agent = await sdk.createAgent({ tools: todoTools(todos), subject: "team-acme", context: { team: "acme" } });
  await agent.prompt("who am i?", { from: { id: "alice", name: "Alice" } });
  const attached = JSON.parse(toolResults(r.model.bodies.at(-1)).at(-1));
  await agent.destroy();
  assert.deepEqual([attached.user, attached.subject, attached.actor, attached.agent, attached.context], ["alice", "team-acme", "alice", agent.session.id, { team: "acme" }]);

  // The runtime publishes issuer metadata naming its keys.
  const issuer = await (await fetch(`${r.base}/.well-known/oauth-authorization-server`)).json() as any;
  assert.deepEqual([issuer.issuer, issuer.jwks_uri], [r.base, `${r.base}/.well-known/jwks.json`]);
});
