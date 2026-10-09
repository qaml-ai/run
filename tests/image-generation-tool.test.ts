import { test } from "node:test";
import assert from "node:assert/strict";
import { lastUser, toolCall, toolResults, until } from "./runtime-server.ts";
import { OPS, OWN, PAYG, start } from "./image-generation-fixture.ts";

/** The last tool result's JSON (its first line; the file reference follows it), if it is JSON. */
const lastResult = (body: any) => { try { return JSON.parse((toolResults(body).at(-1) ?? "").split("\n")[0]!); } catch { return undefined; } };

/** A model that makes an image, edits it, and says where it is; or, told "too dear", asks for a high-quality one. */
function painter(body: any) {
  const results = toolResults(body);
  if (/too dear/.test(lastUser(body) ?? "")) return body.messages.at(-1).role === "tool" ? { role: "assistant", content: `failed: ${results.at(-1)}` } : toolCall("generate_image", { prompt: "a camel", quality: "high" }, "call_dear");
  if (results.length === 0) return toolCall("generate_image", { prompt: "a camel at dawn", quality: "low" }, "call_make");
  if (results.length === 1 && lastResult(body)) return toolCall("generate_image", { prompt: "make it blue", images: [lastResult(body).path], size: "1536x1024" }, "call_edit");
  return { role: "assistant", content: lastResult(body) ? `made ${lastResult(body).path}` : `failed: ${results.at(-1)}` };
}

test("generate_image makes and edits images in the agent's workspace, shows them to the model, and bills them to the run, the agent and the tenant", async t => {
  const { r, openai } = await start(t, painter);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  assert.equal((await r.call("/v1/webhooks", { body: { url: "https://hooks.example.test/usage", events: ["usage.recorded"] }, token: PAYG })).status, 201);
  const agent = (await r.call("/v1/agents", { body: { builtins: ["generate_image"], spendLimit: { usd: 1 }, subject: "user_1", context: { org: "o1" } }, token: PAYG })).json.id;
  assert.ok(r.model.bodies.length === 0);

  const record = await r.prompt(agent, "draw me a camel", PAYG, { actor: "user_2" });
  assert.equal(record.outcome.result.code, undefined, JSON.stringify(record.outcome));
  assert.match(record.outcome.result.reply, /^made \/workspace\/tool-outputs\/generate_image\/[a-f0-9]{8}\/image\.png$/);
  assert.ok(r.model.bodies[0].tools.some((tool: any) => tool.function.name === "generate_image"));
  // The first image, then an edit of it: OpenAI is sent the image the agent made.
  assert.deepEqual(openai.requests.map(call => [call.path, call.fields.quality, call.fields.size, call.images.length]), [["/images/generations", "low", "1024x1024", 0], ["/images/edits", "medium", "1536x1024", 1]]);
  const made = lastResult(r.model.bodies[1]);
  assert.deepEqual({ ...made, path: undefined }, { path: undefined, contentType: "image/png", width: 1024, height: 1024, size: made.size, costUsd: 0.1 });
  // The model is shown the image it made.
  const shown = r.model.bodies[1].messages.filter((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === "image_url"));
  assert.ok(shown.length, "the image is in the next request");
  // Both are files the run wrote.
  assert.deepEqual(record.outcome.result.files.map((file: any) => [file.path.replace(/[a-f0-9]{8}/, "…"), file.contentType]), [["/workspace/tool-outputs/generate_image/…/image.png", "image/png"], ["/workspace/tool-outputs/generate_image/…/image.png", "image/png"]]);

  // $0.10 and $0.11 (an image given): the run's usage, the agent's spend, and a usage.recorded event each with the run's facts.
  assert.ok(Math.abs(record.outcome.result.usage.imageCostUsd - 0.21) < 1e-9, JSON.stringify(record.outcome.result.usage));
  await until(async () => (await r.call(`/v1/agents/${agent}`, { token: PAYG })).json.spendLimit?.spent >= 0.21 - 1e-9, "the agent's spend");
  await until(async () => (await r.db.query("select count(*)::int as n from webhook_deliveries where tenant = 'payg' and body->'data'->>'kind' = 'image'")).rows[0].n === 2, "the events");
  const { rows } = await r.db.query("select body from webhook_deliveries where tenant = 'payg' and body->'data'->>'kind' = 'image' order by created_at");
  assert.deepEqual(rows.map(row => [row.body.data.agentId, row.body.data.requestId, row.body.data.actor, row.body.data.subject, row.body.data.context, row.body.data.images]),
    [[agent, record.id, "user_2", "user_1", { org: "o1" }, 1], [agent, record.id, "user_2", "user_1", { org: "o1" }, 1]]);
  await until(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance <= 1_000_000 - 210_000, "the images' charge");

  // A run's own spend limit refuses an image that would cost more, before anything is sent.
  const sent = openai.requests.length;
  const dear = await r.prompt(agent, "too dear", PAYG, { spendLimit: { usd: 0.05 } });
  assert.match(dear.outcome.result.reply, /^failed: .*Making this image costs about \$0\.1756, more than the \$0\.05\d* left of this run's spend limit/);
  assert.equal(openai.requests.length, sent);
});

test("a stateless run with generate_image gets a workspace for its images, and its usage says what they cost", async t => {
  const { r } = await start(t, painter);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const run = await r.call("/v1/runs?wait=30", { body: { input: "draw me a camel", builtins: ["generate_image"] }, token: PAYG });
  assert.equal(run.status, 200, run.text);
  assert.equal(run.json.status, "completed", run.text);
  assert.match(run.json.text, /^made \/workspace\/tool-outputs\/generate_image\//);
  assert.ok(Math.abs(run.json.usage.imageCostUsd - 0.21) < 1e-9, JSON.stringify(run.json.usage));
});

test("saving a definition or an agent with generate_image and no OpenAI key warns, and the tool says why it cannot", async t => {
  const { r, openai } = await start(t, painter);
  const definition = await r.call("/v1/definitions", { body: { name: "Painter", builtins: ["generate_image"] }, token: OWN });
  assert.equal(definition.status, 201, definition.text);
  assert.deepEqual(definition.json.warnings, ["generate_image can't make images for this account: add an OpenAI key under Models & keys (PUT /v1/providers/openai/key)"]);
  assert.equal((await r.call("/v1/definitions", { body: { name: "Painter", builtins: ["generate_image"] }, token: PAYG })).json.warnings, undefined, "the platform's key will do");
  const agent = (await r.call("/v1/agents", { body: { builtins: ["generate_image"] }, token: OWN })).json.id;
  const record = await r.prompt(agent, "draw me a camel", OWN);
  assert.match(record.outcome.result.reply, /^failed: .*Image generation needs an OpenAI key/);
  assert.equal(openai.requests.length, 0);
});
