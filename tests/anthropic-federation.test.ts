import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AnthropicFederation, anthropicFederationFromEnvironment } from "../src/anthropic-federation.ts";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { normalizeContext } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { explicitKeyStream } from "../src/compaction.ts";

const config = { federation_rule_id: "rule", organization_id: "org", service_account_id: "service", workspace_id: "workspace", region: "us-west-2" };
const token = (index: number) => `sk-ant-oat01-fixture-${index}`;

test("configuration is off when empty, and incomplete configuration can use the static fallback", async () => {
  assert.equal(anthropicFederationFromEnvironment({}), undefined);
  assert.equal(anthropicFederationFromEnvironment({ AGENT_ANTHROPIC_FEDERATION_RULE_ID: " " }), undefined);
  const provider = new AnthropicFederation({ ...config, workspace_id: "" }, { log: () => {}, sts: { send: async () => { throw new Error("must not call STS"); } } });
  assert.deepEqual(await provider.credentials("static"), { apiKey: "static" });
  await assert.rejects(provider.credentials(), /ConfigurationError/);
});

test("STS assertions are fresh, exchanges are single-flight, and advisory and mandatory refresh obey their boundaries", async t => {
  let now = 1_000_000, calls = 0, fail = false;
  let gate = Promise.withResolvers<void>();
  const assertions: string[] = [], events: unknown[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/oauth/token");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers.authorization, undefined);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.deepEqual(body, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `assertion-${calls}`, ...Object.fromEntries(Object.entries(config).filter(([key]) => key !== "region")) });
    assertions.push(body.assertion);
    await gate.promise;
    res.writeHead(fail ? 401 : 200, { "content-type": "application/json" }).end(JSON.stringify(fail ? { error: `private ${body.assertion}` } : { access_token: token(calls), expires_in: 600 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const provider = new AnthropicFederation(config, {
    now: () => now, log: event => events.push(event),
    sts: { send: async (command, options) => {
      assert.deepEqual(command.input, { Audience: ["https://api.anthropic.com"], SigningAlgorithm: "RS256", DurationSeconds: 900 });
      assert.ok(options.abortSignal);
      return { WebIdentityToken: `assertion-${++calls}` };
    } },
    fetch: (url, init) => { assert.equal(url, "https://api.anthropic.com/v1/oauth/token"); return fetch(`${base}/v1/oauth/token`, init); },
  });
  const initial = Array.from({ length: 20 }, () => provider.credentials());
  gate.resolve();
  assert.deepEqual(await Promise.all(initial), Array.from({ length: 20 }, () => ({ apiKey: token(1), bearer: true })));
  assert.equal(calls, 1);
  now += 479_999;
  assert.equal((await provider.credentials()).apiKey, token(1));
  assert.equal(calls, 1);

  // At -120 seconds refresh is advisory: callers get the cached token even while exchange is held.
  now += 1;
  fail = true;
  gate = Promise.withResolvers<void>();
  assert.equal((await provider.credentials()).apiKey, token(1));
  assert.equal((await provider.credentials()).apiKey, token(1));
  assert.equal(calls, 2);
  gate.resolve();
  // Wait for the exchange's failure event, not an intermediate request.
  for (let tries = 0; events.length < 2 && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(events.length, 2);
  assert.equal((await provider.credentials()).apiKey, token(1));
  assert.equal(calls, 2, "advisory failure has a short retry cooldown");

  // At -30 seconds old credentials cannot escape; all callers await a fresh exchange or static fallback.
  now += 90_000;
  gate = Promise.withResolvers<void>();
  const mandatory = Array.from({ length: 10 }, () => provider.credentials("static"));
  assert.equal(calls, 3);
  gate.resolve();
  assert.deepEqual(await Promise.all(mandatory), Array.from({ length: 10 }, () => ({ apiKey: "static" })));
  assert.equal(calls, 3);
  fail = false;
  assert.deepEqual(await provider.credentials(), { apiKey: token(4), bearer: true });
  assert.equal(new Set(assertions).size, assertions.length, "no assertion is reused after failure");
  const logged = JSON.stringify(events);
  assert.ok(!logged.includes("assertion-") && !logged.includes("sk-ant-") && !logged.includes("private"));
  assert.ok(logged.includes('"error_class":"TokenEndpointError"'));
});

test("STS and malformed token failures are sanitized, never cached, and can fall back", async () => {
  const events: unknown[] = [];
  let calls = 0;
  const provider = new AnthropicFederation(config, {
    sts: { send: async () => { calls++; if (calls === 1) throw new Error("private credential"); return { WebIdentityToken: "assertion" }; } },
    fetch: async () => Response.json({ access_token: token(1), expires_in: 30 }), log: event => events.push(event),
  });
  assert.deepEqual(await provider.credentials("static"), { apiKey: "static" });
  await assert.rejects(provider.credentials(), /TokenResponseError/);
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify(events).includes("private"));
});

test("platform federation works without a static key, preserves tenant precedence and opt-outs, and falls back with platform accounting", async () => {
  const { db } = await testDatabase();
  let calls = 0, fail = false;
  const provider = new AnthropicFederation(config, { now: () => 1_000_000 + (fail ? 600_000 : 0), log: () => {},
    sts: { send: async () => { calls++; if (fail) throw new Error("fixture"); return { WebIdentityToken: "assertion" }; } },
    fetch: async () => Response.json({ access_token: token(1), expires_in: 600 }),
  });
  let staticKey: string | undefined;
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {
    alice: { tokenSha256: "0".repeat(64) }, bob: { tokenSha256: "1".repeat(64), apiKeys: { anthropic: "admin-key" } },
    carol: { tokenSha256: "2".repeat(64), platformKeys: false },
  }, platformKeys: staticKey ? { anthropic: staticKey } : {} }) });
  await tenants.reload();
  const accounts = new Accounts({ tenants, db, secretsKey: "a".repeat(64), anthropicFederation: provider });
  assert.ok((await accounts.keyedProviders("alice"))("anthropic"));
  assert.ok((await accounts.keyStatus("alice")).some(value => value.provider === "anthropic" && value.source === "platform"));
  assert.deepEqual(await accounts.providerKey("bob", "anthropic"), { key: "admin-key", source: "admin" });
  assert.equal(await accounts.providerKey("carol", "anthropic"), undefined);
  assert.equal(calls, 0);
  assert.deepEqual(await accounts.providerKey("alice", "anthropic"), { key: token(1), bearer: true, source: "platform" });
  await accounts.setKey("alice", "anthropic", "tenant-key");
  assert.deepEqual(await accounts.providerKey("alice", "anthropic"), { key: "tenant-key", source: "tenant" });
  await accounts.deleteKey("alice", "anthropic");
  staticKey = "fallback";
  await tenants.reload();
  fail = true;
  assert.deepEqual(await accounts.providerKey("alice", "anthropic"), { key: "fallback", source: "platform" });
  staticKey = undefined;
  await tenants.reload();
  await assert.rejects(accounts.providerKey("alice", "anthropic"), /StsError/);
});

test("Anthropic response and summary streams send plain bearer auth without subscription headers or prompt injection", async t => {
  const requests: { headers: typeof import("node:http").IncomingMessage.prototype.headers; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "authentication_error", message: "fixture" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const model = { ...getModel("anthropic", "claude-sonnet-5"), baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  for (const prompt of ["Original agent instructions.", "You are a context summarization assistant. Summarize faithfully."]) {
    const context = normalizeContext({ systemPrompt: prompt, messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    const bearer = explicitKeyStream(async () => ({ apiKey: token(1), bearer: true }));
    await (await bearer(model, context, { apiKey: "agent-runtime:key-scope", maxRetries: 0 })).result();
    await (await explicitKeyStream()(model, context, { apiKey: "static-key", maxRetries: 0 })).result();
    const [federated, staticCall] = requests.slice(-2);
    assert.equal(federated.headers.authorization, `Bearer ${token(1)}`);
    assert.equal(federated.headers["x-api-key"], undefined);
    assert.equal(federated.headers["x-app"], undefined);
    assert.doesNotMatch(String(federated.headers["user-agent"]), /claude-cli/);
    assert.doesNotMatch(String(federated.headers["anthropic-beta"]), /oauth|claude-code/);
    assert.equal(federated.headers["anthropic-version"], "2023-06-01");
    assert.equal(federated.headers["anthropic-beta"], staticCall.headers["anthropic-beta"], "only ordinary API beta headers");
    assert.equal(federated.headers["user-agent"], staticCall.headers["user-agent"], "no subscription client identity");
    assert.equal(staticCall.headers.authorization, undefined);
    assert.equal(staticCall.headers["x-api-key"], "static-key");
    assert.deepEqual(federated.body, staticCall.body, "WIF does not alter prompts, tools, or model options");
    assert.deepEqual(federated.body.system.map((part: any) => part.text), [prompt]);
  }
});

test("existing agents recover from static fallback on their next call; tenant and scope keys never exchange", async t => {
  const { runtime, listen } = await import("./runtime-server.ts");
  const { gateway, anthropic } = await import("./provider-fixtures.ts");
  let fail = true, stsCalls = 0, exchanges = 0;
  const endpoint = await listen(t, async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/sts") {
      assert.deepEqual(JSON.parse(raw), { Audience: ["https://api.anthropic.com"], SigningAlgorithm: "RS256", DurationSeconds: 900 });
      res.end(JSON.stringify({ WebIdentityToken: `assertion-${++stsCalls}` }));
    } else {
      assert.equal(req.url, "/v1/oauth/token");
      assert.equal(JSON.parse(raw).assertion, `assertion-${stsCalls}`);
      exchanges++;
      res.writeHead(fail ? 401 : 200).end(JSON.stringify(fail ? { error: "fixture" } : { access_token: token(exchanges), expires_in: 600 }));
    }
  });
  const api = await gateway(t, () => anthropic([{ type: "text", text: "Hello." }], "end_turn"));
  const { OPERATOR, OTHER_OPERATOR } = await import("./runtime-server.ts");
  const { createHash } = await import("node:crypto");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const r = await runtime(t, () => ({}), {
    AGENT_PROVIDER: "anthropic", AGENT_MODEL: "claude-sonnet-5", AGENT_BASE_URL: api.url,
    AGENT_ANTHROPIC_FEDERATION_RULE_ID: config.federation_rule_id, AGENT_ANTHROPIC_ORGANIZATION_ID: config.organization_id,
    AGENT_ANTHROPIC_SERVICE_ACCOUNT_ID: config.service_account_id, AGENT_ANTHROPIC_WORKSPACE_ID: config.workspace_id,
    TEST_ANTHROPIC_FEDERATION_ENDPOINT: endpoint, AGENT_VERIFY_KEYS: "false",
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32",
  }, { tenants: { alice: { tokenSha256: hash(OPERATOR) }, bob: { tokenSha256: hash(OTHER_OPERATOR), apiKeys: { anthropic: "tenant-own" } } }, platformKeys: { anthropic: "static-fallback" } },
  { execArgv: ["--import", new URL("./fixtures/anthropic-federation.mjs", import.meta.url).href] });
  const created = await r.call("/v1/agents", { body: { systemPrompt: "Keep this system prompt." } });
  assert.equal(created.status, 201, created.text);
  assert.equal(exchanges, 0, "agent creation stores a per-call marker, not a short-lived token");
  assert.equal((await r.prompt(created.json.id, "first")).outcome.result.reply, "Hello.");
  assert.equal(api.requests.at(-1)!.headers["x-api-key"], "static-fallback");
  assert.equal(api.requests.at(-1)!.headers.authorization, undefined);
  fail = false;
  assert.equal((await r.prompt(created.json.id, "second")).outcome.result.reply, "Hello.");
  const request = api.requests.at(-1)!;
  assert.equal(request.headers.authorization, `Bearer ${token(2)}`);
  assert.equal(request.headers["x-api-key"], undefined);
  assert.equal(request.headers["x-app"], undefined);
  assert.doesNotMatch(String(request.headers["anthropic-beta"]), /oauth|claude-code/);
  assert.doesNotMatch(JSON.stringify(request.body.system), /You are Claude Code/);
  assert.match(JSON.stringify(request.body.system), /Keep this system prompt/);
  const own = await r.call("/v1/agents", { body: {}, token: OTHER_OPERATOR });
  assert.equal(own.status, 201, own.text);
  await r.prompt(own.json.id, "own", OTHER_OPERATOR);
  assert.equal(api.requests.at(-1)!.headers["x-api-key"], "tenant-own");
  assert.equal((await r.call("/v1/key-scopes/customer/providers/anthropic", { method: "PUT", body: { apiKey: "scope-own" } })).status, 200);
  const scoped = await r.call("/v1/agents", { body: { keyScope: "customer" } });
  assert.equal(scoped.status, 201, scoped.text);
  await r.prompt(scoped.json.id, "scope");
  assert.equal(api.requests.at(-1)!.headers["x-api-key"], "scope-own");
  assert.equal(exchanges, 2);
  assert.equal(stsCalls, 2);
  const usage = (await r.call("/v1/usage")).json;
  assert.equal(usage.totals.platformResponses, 2, "both WIF and its static fallback are billed as platform calls");
  assert.ok(r.logs.some(line => line.includes('"type":"anthropic_federation_fallback"')));
  assert.ok(r.logs.some(line => line.includes('"type":"anthropic_federation_exchange"') && line.includes('"ok":true')));
  const logs = r.logs.join("\n");
  assert.ok(!logs.includes("sk-ant-oat01") && !logs.includes("assertion-"));
});
