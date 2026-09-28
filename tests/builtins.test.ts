import { test } from "node:test";
import assert from "node:assert/strict";
import { readableText, runBuiltin } from "../src/builtins.ts";
import { Outbound } from "../src/outbound.ts";
import { LostClaim, Ownership } from "../src/ownership.ts";
import { Scheduler } from "../src/scheduler.ts";
import { testDatabase } from "./database.ts";
import { lastUser, listen, runtime, toolCall, toolResults, until } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const PAGE = `<!doctype html><html><head><title>Release notes &amp; more</title><style>body { color: red }</style><script>alert("x")</script></head>
<body><nav>Home</nav><h1>Hello</h1><p>World&nbsp;&mdash; ok &#x263A;</p><!-- hidden --><ul><li>one</li><li>two</li></ul><noscript>enable js</noscript></body></html>`;

test("HTML is reduced to the text a reader sees", () => {
  assert.deepEqual(readableText(PAGE), { title: "Release notes & more", text: "Home\n\nHello\n\nWorld — ok ☺\n\n- one\n- two" });
});

test("web_fetch reads public pages as text, from the model and js_exec, and never reaches inside", async t => {
  const pages = await listen(t, (req, res) => {
    if (req.url === "/page") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    if (req.url === "/moved") return res.writeHead(302, { Location: "/page" }).end();
    if (req.url === "/meta") return res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (req.url === "/binary") return res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.alloc(64));
    if (req.url === "/long") return res.writeHead(200, { "Content-Type": "text/plain" }).end("x".repeat(50_000));
    res.writeHead(404).end("no such page");
  });
  const r = await runtime(t, (_body, index) => [
    toolCall("web_fetch", { url: `${pages}/moved` }),
    toolCall("web_fetch", { url: `${pages}/meta` }),
    toolCall("web_fetch", { url: `${pages}/binary` }),
    toolCall("js_exec", { code: `const page = await tools.web_fetch({ url: "${pages}/long", maxCharacters: 1000 }); return [page.text.length, page.truncated, page.totalCharacters].join(",");` }),
  ][index] ?? { role: "assistant", content: "done" }, LOCAL);
  assert.equal((await r.call("/v1/definitions", { body: { name: "Bad", builtins: ["web_browse"] } })).status, 400);
  assert.equal((await r.call("/v1/definitions", { body: { name: "Bad", builtins: ["schedule", "schedule"] } })).status, 400);
  const definition = (await r.call("/v1/definitions", { body: { name: "Reader", builtins: ["web_fetch"] } })).json;
  assert.deepEqual(definition.builtins, ["web_fetch"]);
  await r.prompt((await r.call("/v1/agents", { body: { definition: definition.id } })).json.id, "read it");
  assert.ok(r.model.bodies[0].tools.some((tool: any) => tool.function.name === "web_fetch"));
  const page = JSON.parse(toolResults(r.model.bodies[1]).at(-1));
  assert.deepEqual(page, { url: `${pages}/page`, status: 200, contentType: "text/html", title: "Release notes & more", text: "Home\n\nHello\n\nWorld — ok ☺\n\n- one\n- two" });
  assert.match(toolResults(r.model.bodies[2]).at(-1), /169\.254\.169\.254 is a private, local or reserved address/);
  assert.match(toolResults(r.model.bodies[3]).at(-1), /"path":"\/workspace\/tool-outputs\/web_fetch\/[a-f0-9]{8}\/binary"/, "a file that is not text is saved");
  assert.match(toolResults(r.model.bodies[4]).at(-1), /1000,true,50000/);
});

test("web_fetch refuses internal addresses when nothing is allowed", async t => {
  const pages = await listen(t, (_req, res) => res.end("secret"));
  const r = await runtime(t, (_body, index) => [toolCall("web_fetch", { url: pages }), toolCall("web_fetch", { url: "https://localhost:65000/" })][index] ?? { role: "assistant", content: "done" });
  const definition = (await r.call("/v1/definitions", { body: { name: "Reader", builtins: ["web_fetch"] } })).json;
  await r.prompt((await r.call("/v1/agents", { body: { definition: definition.id } })).json.id, "read it");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /127\.0\.0\.1 is a private, local or reserved address/, "http is tried as https, and still refused");
  assert.match(toolResults(r.model.bodies[2]).at(-1), /localhost resolves to/);
});

test("an agent schedules, lists and cancels its own wake-ups, and wakes up", async t => {
  const r = await runtime(t, body => {
    const text = lastUser(body);
    const answered = body.messages.at(-1).role === "tool";
    if (answered) return { role: "assistant", content: "noted" };
    if (text === "remind me") return toolCall("schedule", { text: "check the oven", inSeconds: 1 });
    if (text === "every hour") return toolCall("schedule", { text: "hourly check", inSeconds: 3600, everySeconds: 3600 });
    if (text === "what is scheduled") return toolCall("list_schedules", {});
    if (text.startsWith("cancel ")) return toolCall("cancel_schedule", { id: text.slice(7) });
    return { role: "assistant", content: `heard: ${text}` };
  });
  const definition = (await r.call("/v1/definitions", { body: { name: "Planner", builtins: ["schedule"] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  await r.prompt(agent, "remind me");
  const created = JSON.parse(toolResults(r.model.bodies[1]).at(-1));
  assert.equal(created.text, "check the oven");
  assert.deepEqual((await r.call(`/v1/agents/${agent}/schedules`)).json.map((entry: any) => entry.id), [created.id]);
  await until(() => r.model.bodies.some(body => lastUser(body) === "check the oven"), "the wake-up");

  await r.prompt(agent, "every hour");
  const hourly = JSON.parse(toolResults(r.model.bodies.at(-1)).at(-1));
  assert.equal(hourly.everySeconds, 3600);
  await r.prompt(agent, "what is scheduled");
  assert.deepEqual(JSON.parse(toolResults(r.model.bodies.at(-1)).at(-1)).schedules.map((entry: any) => entry.id), [hourly.id], "the one-off wake-up is gone once delivered");
  await r.prompt(agent, `cancel ${hourly.id}`);
  assert.deepEqual(JSON.parse(toolResults(r.model.bodies.at(-1)).at(-1)), { cancelled: true });
  assert.deepEqual((await r.call(`/v1/agents/${agent}/schedules`)).json, []);
});

test("a node that lost the agent can no longer schedule for it", async t => {
  const { db } = await testDatabase();
  const ownership = new Ownership(db, { node: "http://a", ttlMs: 60_000 });
  await ownership.start();
  t.after(() => ownership.close());
  const taken = await ownership.acquire("client_x");
  assert.ok("claim" in taken);
  const scheduler = new Scheduler({ db, node: "http://a", deliver: async () => {} });
  const services = { outbound: new Outbound(), scheduler };
  const context = { tenant: "alice", agent: "client_x", claim: taken.claim };
  const signal = new AbortController().signal;
  await runBuiltin(services, context, "schedule", { text: "first", inSeconds: 60 }, signal);
  await db.query("update actor_owners set node = 'http://b', session = gen_random_uuid(), epoch = epoch + 1 where actor = 'client_x'");
  await assert.rejects(runBuiltin(services, context, "schedule", { text: "stale", inSeconds: 60 }, signal), LostClaim);
  const [only] = await scheduler.list("client_x");
  await assert.rejects(runBuiltin(services, context, "cancel_schedule", { id: only.id }, signal), LostClaim);
  assert.deepEqual((await scheduler.list("client_x")).map(schedule => schedule.text), ["first"]);
});

test("an agent takes builtins without a definition: at creation, by upsert and by configuration, and only from its tenant", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const tools = () => (r.model.bodies.at(-1).tools ?? []).map((tool: any) => tool.function.name).filter((name: string) => ["web_fetch", "schedule", "list_schedules", "ask_user"].includes(name)).sort();
  assert.equal((await r.call("/v1/agents", { body: { builtins: ["web_browse"] } })).status, 400);
  const definition = (await r.call("/v1/definitions", { body: { name: "Planner", builtins: ["schedule"] } })).json;
  assert.equal((await r.call("/v1/agents", { body: { definition: definition.id, builtins: ["web_fetch"] } })).status, 400, "a definition's agent has its definition's builtins");

  const key = { "Idempotency-Key": "researcher" };
  const made = (await r.call("/v1/agents", { body: { builtins: ["web_fetch"] }, headers: key })).json;
  await r.prompt(made.id, "one");
  assert.deepEqual(tools(), ["web_fetch"]);
  assert.deepEqual((await r.call(`/v1/agents/${made.id}`)).json.builtins, ["web_fetch"]);

  const upserted = (await r.call("/v1/agents", { body: { builtins: ["web_fetch", "schedule"] }, headers: key })).json;
  assert.equal(upserted.id, made.id);
  await until(async () => (await r.call(`/v1/agents/${made.id}/requests/${upserted.reconfigured.id}`)).json.state === "completed", "the upsert");
  await r.prompt(made.id, "two");
  assert.deepEqual(tools(), ["list_schedules", "schedule", "web_fetch"]);
  const repeated = (await r.call("/v1/agents", { body: { builtins: ["web_fetch", "schedule"] }, headers: key })).json.reconfigured;
  const settled = await until(async () => { const record = (await r.call(`/v1/agents/${made.id}/requests/${repeated.id}`)).json; return record.state === "completed" && record; }, "the repeated upsert");
  assert.equal(settled.outcome.result.changed, false, "the same builtins change nothing");

  const configured = await r.call(`/v1/agents/${made.id}/configuration`, { method: "PATCH", body: { builtins: [] } });
  assert.equal(configured.status, 202, configured.text);
  await until(async () => (await r.call(`/v1/agents/${made.id}/requests/${configured.json.id}`)).json.state === "completed", "the configuration");
  assert.deepEqual((await r.call(`/v1/agents/${made.id}`)).json.builtins, []);
  await r.prompt(made.id, "three");
  assert.deepEqual(tools(), []);
  const own = await fetch(`${r.base}/clients/${made.id}/requests`, { method: "POST", headers: { Authorization: `Bearer ${made.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "own", method: "configure", params: { builtins: ["web_fetch"] } }) });
  assert.equal(own.status, 403, "the agent cannot give itself builtins");
});
