import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { listen, runtime, toolCall, toolResults, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required });

/** Standard Webhooks verification, written from the spec rather than taken from the runtime. */
function verified(secret: string, headers: IncomingHttpHeaders, body: string) {
  const id = headers["webhook-id"], timestamp = headers["webhook-timestamp"], signatures = String(headers["webhook-signature"] ?? "");
  if (typeof id !== "string" || typeof timestamp !== "string" || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  return signatures.split(" ").includes(`v1,${expected}`);
}

/** A receiver for HTTP tools that records what it gets. */
async function receiver(t: T) {
  const requests: { path: string; method: string; headers: IncomingHttpHeaders; body: string }[] = [];
  let otherHits = 0;
  const other = await listen(t, (_req, res) => { otherHits++; res.end("{}"); });
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url!, method: req.method!, headers: req.headers, body });
    const json = (status: number, value: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (req.url === "/orders") return json(200, { order: JSON.parse(body).id, status: "shipped" });
    if (req.url === "/text") return res.writeHead(200, { "Content-Type": "text/plain" }).end("plain words");
    if (req.url === "/fail") return res.writeHead(500, { "Content-Type": "text/plain" }).end("database down");
    if (req.url === "/redirect") return res.writeHead(307, { Location: `${other}/elsewhere` }).end();
    if (req.url === "/big") return json(200, { blob: "x".repeat(2 * 1024 * 1024) });
    if (req.url === "/slow") return;
    res.writeHead(404).end();
  });
  return { url, requests, otherHits: () => otherHits };
}

test("HTTP tools send signed arguments, from the model and js_exec, and return JSON or text", async t => {
  const hook = await receiver(t);
  const r = await runtime(t, (_body, index) => [
    toolCall("lookup_order", { id: "A1" }),
    toolCall("js_exec", { code: "const r = await tools.lookup_order({ id: 'B2' }); return r.status + ' ' + r.order;" }),
    toolCall("plain_text", {}),
    toolCall("broken", {}),
  ][index] ?? { role: "assistant", content: "done" }, LOCAL);
  const created = await r.call("/v1/definitions", { body: { name: "Orders", httpTools: [
    { name: "lookup_order", description: "Look up an order", inputSchema: object({ id: { type: "string" } }, ["id"]), url: `${hook.url}/orders`, headers: { "X-Api-Key": "k1-secret-value" }, exposure: "both" },
    { name: "plain_text", description: "Some text", inputSchema: object(), url: `${hook.url}/text`, method: "PUT", exposure: "direct" },
    { name: "broken", description: "Always fails", inputSchema: object(), url: `${hook.url}/fail`, exposure: "direct" },
  ] } });
  assert.equal(created.status, 201, created.text);
  const secret = created.json.signingSecret as string;
  assert.match(secret, /^whsec_[A-Za-z0-9+/]{43}=$/);
  assert.deepEqual(created.json.httpTools[0].headerNames, ["X-Api-Key"]);
  const stored = JSON.stringify((await r.db.query("select * from definitions")).rows);
  for (const text of [(await r.call(`/v1/definitions/${created.json.id}`)).text, (await r.call("/v1/definitions")).text, stored]) {
    assert.equal(text.includes(secret.slice(6)), false);
    assert.equal(text.includes("k1-secret-value"), false);
  }

  const agent = (await r.call("/v1/agents", { body: { definition: created.json.id } })).json;
  assert.equal((await r.prompt(agent.id, "check my orders")).outcome.result.reply, "done");
  const offered = r.model.bodies[0].tools.map((tool: any) => tool.function.name);
  for (const name of ["broken", "js_exec", "lookup_order", "plain_text"]) assert.ok(offered.includes(name), name);
  assert.match(toolResults(r.model.bodies[1]).at(-1), /"status":"shipped"/);
  assert.match(toolResults(r.model.bodies[2]).at(-1), /shipped B2/);
  assert.match(toolResults(r.model.bodies[3]).at(-1), /plain words/);
  assert.match(toolResults(r.model.bodies[4]).at(-1), /broken answered HTTP 500: database down/);

  assert.deepEqual(hook.requests.map(request => [request.method, request.path, request.body]), [
    ["POST", "/orders", '{"id":"A1"}'], ["POST", "/orders", '{"id":"B2"}'], ["PUT", "/text", "{}"], ["POST", "/fail", "{}"],
  ]);
  for (const request of hook.requests) {
    assert.ok(verified(secret, request.headers, request.body), `${request.path} is signed`);
    assert.equal(verified(secret, request.headers, request.body.replace("}", ',"x":1}')), false, "a changed body fails verification");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["x-agent-runtime-agent"], agent.id);
    assert.equal(request.headers["x-api-key"], request.path === "/orders" ? "k1-secret-value" : undefined, "headers go to their own tool only");
  }
  assert.equal(new Set(hook.requests.map(request => request.headers["webhook-id"])).size, 4, "every call has its own id");
});

test("HTTP tools are held to the outbound guard: no internal targets, no redirects, bounded answers", async t => {
  const hook = await receiver(t);
  const r = await runtime(t, (_body, index) => [toolCall("moved", {}), toolCall("huge", {}), toolCall("slow", {})][index] ?? { role: "assistant", content: "done" }, LOCAL);
  for (const url of ["http://10.0.0.1/hook", "http://169.254.169.254/latest", "http://[fd00:ec2::254]/", "http://0x0a000001/", "file:///etc/passwd"]) {
    const saved = await r.call("/v1/definitions", { body: { name: "Bad", httpTools: [{ name: "bad", description: "x", inputSchema: object(), url }] } });
    assert.equal(saved.status, 400, url);
  }
  for (const tool of [
    { name: "bad__name", description: "x", inputSchema: object(), url: hook.url },
    { name: "bad", description: "x", inputSchema: { type: "string" }, url: hook.url },
    { name: "bad", description: "x", inputSchema: object(), url: hook.url, method: "GET" },
    { name: "bad", description: "x", inputSchema: object(), url: hook.url, headers: { "Webhook-Signature": "v1,forged" } },
  ]) assert.equal((await r.call("/v1/definitions", { body: { name: "Bad", httpTools: [tool] } })).status, 400, JSON.stringify(tool));
  assert.equal((await r.call("/v1/definitions", { body: { name: "Clash", tools: [{ name: "moved", description: "x", parameters: object() }], httpTools: [{ name: "moved", description: "x", inputSchema: object(), url: hook.url }] } })).status, 400);

  const definition = (await r.call("/v1/definitions", { body: { name: "Guarded", httpTools: [
    { name: "moved", description: "Redirects", inputSchema: object(), url: `${hook.url}/redirect`, exposure: "direct" },
    { name: "huge", description: "Too big", inputSchema: object(), url: `${hook.url}/big`, exposure: "direct" },
    { name: "slow", description: "Never answers", inputSchema: object(), url: `${hook.url}/slow`, exposure: "direct", timeoutMs: 1000 },
  ] } })).json;
  await r.prompt((await r.call("/v1/agents", { body: { definition: definition.id } })).json.id, "go");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /Redirects are not followed/);
  assert.equal(hook.otherHits(), 0);
  assert.match(toolResults(r.model.bodies[2]).at(-1), /larger than 1048576 bytes/);
  assert.match(toolResults(r.model.bodies[3]).at(-1), /No response within 1000 ms/);
});

test("a rotated signing secret reaches agents when the definition is applied to them", async t => {
  const hook = await receiver(t);
  const r = await runtime(t, (body, _index) => /call it/.test(JSON.stringify(body.messages.at(-1))) ? toolCall("lookup_order", { id: "C3" }, `call_${Math.random()}`) : { role: "assistant", content: "done" }, LOCAL);
  const tool = { name: "lookup_order", description: "Look up an order", inputSchema: object({ id: { type: "string" } }), url: `${hook.url}/orders`, exposure: "direct" };
  const created = (await r.call("/v1/definitions", { body: { name: "Orders", httpTools: [tool] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: created.id } })).json.id;
  const rotated = await r.call(`/v1/definitions/${created.id}/signing-secret`, { method: "POST" });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.json.revision, 2);
  assert.notEqual(rotated.json.signingSecret, created.signingSecret);
  assert.equal((await r.call(`/v1/definitions/${created.id}`)).text.includes("signingSecret"), false);

  await r.prompt(agent, "call it");
  assert.ok(verified(created.signingSecret, hook.requests.at(-1)!.headers, hook.requests.at(-1)!.body), "the agent still has the old secret");
  await r.call(`/v1/definitions/${created.id}`, { method: "PATCH", body: { apply: "all" } });
  await r.prompt(agent, "call it");
  assert.ok(verified(rotated.json.signingSecret, hook.requests.at(-1)!.headers, hook.requests.at(-1)!.body), "and the new one once applied");
  assert.equal(verified(created.signingSecret, hook.requests.at(-1)!.headers, hook.requests.at(-1)!.body), false);

  // A definition from before signing secrets (as migration 006 made them) gets one with its first HTTP tool.
  await r.db.query("insert into definitions (id, tenant, name, revision, spec, created_at, updated_at) values ('def_0123456789abcdef0123', 'alice', 'Old', 1, '{}', 1, 1)");
  const first = await r.call("/v1/definitions/def_0123456789abcdef0123", { method: "PATCH", body: { httpTools: [tool] } });
  assert.match(first.json.signingSecret, /^whsec_/);
  assert.equal((await r.call("/v1/definitions/def_0123456789abcdef0123", { method: "PATCH", body: { httpTools: [tool] } })).json.signingSecret, undefined);
});
