import { portedTest } from "../ported.ts";
import assert from "node:assert/strict";
import {gateway,responses} from "../../provider-fixtures.ts";
import {listen,runtime} from "../support.ts";
const endpoint = (extra: object = {}) => ({ context_length: 400_000, max_completion_tokens: 64_000, supported_parameters: ["tools", "reasoning", "temperature"], pricing: { prompt: "0.000075", completion: "0.0003", input_cache_read: "0.0000075" }, ...extra });
const answers: Record<string, () => [number, object]> = {
  "/models/new/dear/endpoints": () => [200, { data: { name: "New: Dear", architecture: { input_modalities: ["text"] }, endpoints: [endpoint(), endpoint({ context_length: 200_000, max_completion_tokens: 32_000, pricing: { prompt: "0.000001", completion: "0.000002" } })] } }],
  "/models/new/no-tools/endpoints": () => [200, { data: { endpoints: [endpoint({ supported_parameters: ["temperature"] })] } }],
  "/models/new/down/endpoints": () => [503, {}],
  "/models/new/plain/endpoints": () => [200, { data: { endpoints: [endpoint({ supported_parameters: ["tools"], max_completion_tokens: null })] } }],
};
const server = async (t: Parameters<typeof runtime>[0]) => listen(t, (req, res) => {
  const [status, body] = answers[req.url!]?.() ?? [404, { error: { code: 404, message: "No model found" } }];
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
});


const USD=1_000_000;
portedTest("models","tests/openrouter-model.test.ts:56")("over the API: an agent keeps what the lookup said, a move looks up too, and its calls name the id and add no routing", async t => {
  const list = await server(t);
  const provider = await gateway(t, () => responses([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Passed through." }] }]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_OPENROUTER_API_URL: list });
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  const made = await r.call("/v1/agents", { body: { model: "openrouter/new/plain", keyScope: "hosted" } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal((await r.call(`/v1/agents/${made.json.id}`)).json.model, "openrouter/new/plain");
  const refused = await r.call("/v1/agents", { body: { model: "openrouter/new/nothing" } });
  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(refused.json), /OpenRouter has no model/);
  const moved = await r.call(`/v1/agents/${made.json.id}/configuration`, { method: "PATCH", body: { model: "openrouter/new/dear" } });
  assert.equal(moved.status, 202, JSON.stringify(moved.json));
  assert.equal((await r.prompt(made.json.id, "Hi")).outcome.result.reply, "Passed through.");
  const body = provider.requests.at(-1)!.body;
  assert.equal(body.model, "new/dear");
  assert.equal(body.provider, undefined);
  assert.equal(body.reasoning?.effort, "low", "an agent with no level, on a model the lookup can't say can turn it off");
});

portedTest("models","tests/openrouter-model.test.ts:109")("over the API: the lookup's price reaches an end user's hold, so a dear model is refused where the mid-range price would have started", async t => {
  const list = await server(t);
  const provider = await gateway(t, () => responses([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Should not be asked." }] }]));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_OPENROUTER_API_URL: list });
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  await r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true } });
  await r.call("/v1/end-users/person/entries", { body: { kind: "grant", amount: USD / 10, key: "pay" } });
  // About 10,000 tokens of input: $0.75 at the looked-up $75 per million, $0.03 at the mid-range $3. On $0.10, only the second would start.
  const text = "word ".repeat(8_000);
  const dear = (await r.call("/v1/agents", { body: { model: "openrouter/new/dear", keyScope: "hosted", subject: "person", bucket: "b" } })).json.id;
  const refused = await r.prompt(dear, text);
  assert.equal(provider.requests.length, 0, "no call was made");
  assert.equal(refused.outcome.result.stopped, "spend_limit");
  assert.equal(refused.outcome.result.limit, "end_user");
  // With no lookup, the same call starts at the mid-range price.
  const down = (await r.call("/v1/agents", { body: { model: "openrouter/new/down", keyScope: "hosted", subject: "person", bucket: "b" } })).json.id;
  const started = await r.prompt(down, text);
  assert.equal(started.outcome.result.reply, "Should not be asked.");
  assert.equal(provider.requests.length, 1);
});
