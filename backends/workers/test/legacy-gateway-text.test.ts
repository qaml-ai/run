import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Agents } from "../../../clients/agents.ts";
import {
  legacyGatewayTextRoute, legacyGatewayTextInput, legacyGatewayTextPrincipal, readLegacyGatewayText,
  routeLegacyGatewayText, type LegacyGatewayTextOwner,
} from "../src/legacy-gateway-text.ts";
import type { AuthContext } from "../src/control.ts";

const key = "a6d5b846-63db-401b-abfd-57bc9822780e";
const credential = "Bearer local-gateway-test-key";
const tenant = "gateway-fixture";
const subject = "123456789012345678";
const bucket = "bot:0123456789abcdef";
const model = "azure/gpt-6.2-sol";
const scope = JSON.stringify({
  tenant,
  authorizationSha256: createHash("sha256").update(credential).digest("hex"),
});
const gatewayBody = {
  input: "fixture", model, codeMode: false, runLimits: { maxSeconds: 23 }, retentionSeconds: 60,
  dataCollection: "deny", subject, bucket, wait: true,
};
const makeRequest = (body: unknown, host = "run.camelai.com", url = "/v1/runs", headers: Record<string, string> = {}) =>
  new Request("https://" + host + url, { method: "POST", headers: {
    "authorization": credential, "content-type": "application/json", "idempotency-key": key, ...headers,
  }, body: JSON.stringify(body) });

test("the existing SDK sends the exact same typed, deterministically keyed run on both aliases", async () => {
  const observed = [];
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    const agents = new Agents({ url: "https://" + host, apiKey: credential.slice("Bearer ".length), fetch: async (resource, init) => {
      const request = new Request(resource, init);
      assert.ok(legacyGatewayTextRoute(request));
      assert.ok(legacyGatewayTextPrincipal({ kind: "operator", tenantId: tenant, scopes: ["*"], principal: { via: "operator", tenant } }, { tenant }));
      const input = await readLegacyGatewayText(request, tenant);
      assert.ok(input);
      assert.equal(input.instructions, "fixture instructions");
      assert.equal(input.json, true);
      assert.equal(input.timeoutMs, 23_000);
      assert.equal(input.bucket, bucket);
      assert.equal(input.subject, subject);
      assert.deepEqual(await request.json(), {
        ...gatewayBody, systemPrompt: "fixture instructions", output: { schema: { type: "object", additionalProperties: true } },
      });
      observed.push(input);
      return Response.json({ id: input.runId, status: "completed", text: "fixture", error: null,
        usage: { costUsd: 0.00001 }, output: { result: "fixture" }, files: [], toolErrors: [], toolCalls: [], sourceErrors: [] });
    } });
    const result = await agents.run({ input: gatewayBody.input, model, codeMode: false, runLimits: gatewayBody.runLimits,
      retentionSeconds: 60, dataCollection: "deny", subject, bucket,
      instructions: "fixture instructions", output: { type: "object", additionalProperties: true }, idempotencyKey: key, throwOnError: false });
    assert.equal(result.error, null);
    assert.equal(result.text, "fixture");
    assert.deepEqual(result.output, { result: "fixture" });
  }
  assert.deepEqual(observed[1], observed[0]);
  assert.equal(observed[0].runId, "run_8cf6a63c8f048fe8e5dec18caf5fd2fbdb92c1eb");
});

test("other credentials, aliases, tenants and OAuth do not select new native work", async () => {
  const fixture = routeFixture();
  assert.equal(legacyGatewayTextRoute(makeRequest(gatewayBody, "example.test")), false);
  assert.equal(legacyGatewayTextRoute(makeRequest(gatewayBody, "run.camelai.com:8443")), false);
  assert.equal(legacyGatewayTextRoute(makeRequest(gatewayBody, "run.camelai.com", "/v1/runs?wait=1")), false);
  assert.equal(legacyGatewayTextRoute(makeRequest(gatewayBody, undefined, undefined, { "idempotency-key": "historical-key" })), false);
  assert.equal(await fixture.route(makeRequest(gatewayBody, undefined, undefined, { authorization: "Bearer alternate" }), "native-new"), null);
  assert.equal(legacyGatewayTextPrincipal({ kind: "operator", tenantId: "foreign", scopes: ["*"], principal: { tenant: "foreign", via: "operator" } }, { tenant }), false);
  assert.equal(legacyGatewayTextPrincipal({ kind: "oauth", tenantId: tenant, scopes: ["*"], principal: { tenant, via: "oauth" } }, { tenant }), false);
  assert.deepEqual(fixture.starts, []);
});

test("unsupported requests have no translated admission and keep the original JSON body for ECS", async () => {
  for (const change of [
    { bucket: "builder" }, { subject: "bot:fedcba9876543210" }, { subject: undefined }, { model: "azure/gpt-6-luna" },
    { input: [{ type: "file", url: "https://example.test/local.png" }] }, { retentionSeconds: 61 }, { wait: 25 },
    { spendLimit: { usd: 1 } }, { runLimits: { maxSeconds: 23, maxResponses: 5 } }, { modelHeaders: { foo: "bar" } },
    { output: { schema: { type: "object", additionalProperties: true, required: ["secret"] } } },
  ]) {
    const body = { ...gatewayBody, ...change };
    const request = makeRequest(body);
    assert.equal(await readLegacyGatewayText(request, tenant), null);
    assert.deepEqual(await request.json(), JSON.parse(JSON.stringify(body)));
  }
});

test("equivalent field order yields the same fingerprint; changed bodies retain the same run ID", () => {
  const input = legacyGatewayTextInput(gatewayBody, tenant, key)!;
  const reordered = legacyGatewayTextInput(Object.fromEntries(Object.entries(gatewayBody).reverse()), tenant, key);
  assert.deepEqual(reordered, input);
  const changed = legacyGatewayTextInput({ ...gatewayBody, input: "another body" }, tenant, key)!;
  assert.equal(changed.runId, input.runId);
  assert.notEqual(changed.fingerprint, input.fingerprint);
});

function routeFixture() {
  const pins = new Map<string, LegacyGatewayTextOwner>();
  const api: AuthContext = { kind: "api", tenantId: tenant, scopes: ["*"], principal: { tenant, via: "token" } };
  const runId = legacyGatewayTextInput(gatewayBody, tenant, key)!.runId;
  const reads: string[] = [];
  const starts: string[] = [];
  const probes: string[] = [];
  let ready = false;
  let exists = async (_session: string) => false;
  const config = (mode?: "native-new" | "legacy-new") => JSON.stringify({ ...JSON.parse(scope), mode });
  const route = (request: Request, mode?: "native-new" | "legacy-new", options?: { auth?: AuthContext; unplug?: boolean }) =>
    routeLegacyGatewayText(request, {
      config: config(mode),
      routes: value => {
        assert.equal(value, tenant);
        return {
          lookup: async id => pins.get(id) ?? null,
          pin: async (id, owner) => {
            if (!pins.has(id)) pins.set(id, owner);
            return pins.get(id)!;
          },
        };
      },
      auth: async () => options?.auth ?? api,
      legacyExists: async session => { probes.push(session); return exists(session); },
      admitHttp: async () => {},
      runtime: options?.unplug ? undefined : {
        start: async input => {
          starts.push(input.runId);
          return Response.json({ id: input.runId, status: ready ? "completed" : "running" }, { status: ready ? 200 : 202 });
        },
        read: async id => {
          reads.push(id);
          return Response.json({ id, status: ready ? "completed" : "running" }, { status: ready ? 200 : 202 });
        },
      },
    });
  return { route, pins, runId, reads, starts, probes, ready: () => { ready = true; },
    exists: (test: typeof exists) => { exists = test; } };
}

test("shadow ownership preserves an accepted legacy request after enabling native requests", async () => {
  const fixture = routeFixture();
  const request = makeRequest(gatewayBody);
  assert.equal(await fixture.route(request), null);
  assert.deepEqual(await request.json(), gatewayBody);
  assert.deepEqual(fixture.pins.get(fixture.runId), { owner: "legacy" });
  assert.equal(await fixture.route(makeRequest(gatewayBody, "agents.camelai.dev"), "native-new"), null);
  assert.deepEqual(fixture.probes, []);
  assert.deepEqual(fixture.starts, []);
});

test("an existing legacy id, including a tombstone, keeps the UUID on ECS", async () => {
  const fixture = routeFixture();
  fixture.exists(async () => true);
  const request = makeRequest(gatewayBody);
  assert.equal(await fixture.route(request, "native-new"), null);
  assert.deepEqual(fixture.probes, ["client_" + fixture.runId.slice("run_".length)]);
  assert.deepEqual(await request.json(), gatewayBody);
  assert.deepEqual(fixture.pins.get(fixture.runId), { owner: "legacy" });
});

test("native POST and original-auth polling survive policy rollback on both aliases", async () => {
  const fixture = routeFixture();
  const admitted = await fixture.route(makeRequest(gatewayBody), "native-new");
  assert.equal(admitted?.status, 202);
  const get = (host: string, query = "") => new Request(`https://${host}/v1/runs/${fixture.runId}${query}`, {
    headers: { authorization: credential },
  });
  const pending = await fixture.route(get("agents.camelai.dev"), "legacy-new");
  assert.equal(pending?.status, 200);
  assert.deepEqual(await pending?.json(), { id: fixture.runId, status: "running" });
  const invalidWait = await fixture.route(get("run.camelai.com", "?wait=-5"), "legacy-new");
  assert.equal(invalidWait?.status, 400);
  const wrongTenant: AuthContext = { kind: "api", tenantId: "foreign", scopes: ["*"], principal: { tenant: "foreign", via: "token" } };
  assert.equal(await fixture.route(get("run.camelai.com"), "legacy-new", { auth: wrongTenant }), null);
  const changed = await fixture.route(makeRequest({ ...gatewayBody, model: "azure/gpt-6-luna" }), "legacy-new");
  assert.equal(changed?.status, 409);
  assert.equal((await changed?.json()).code, "IDEMPOTENCY_CONFLICT");
  const unreachable = await fixture.route(get("agents.camelai.dev"), "legacy-new", { unplug: true });
  assert.equal(unreachable?.status, 503);
  fixture.ready();
  const oauth: AuthContext = { kind: "oauth", tenantId: tenant, scopes: ["*"], principal: { tenant, via: "oauth" } };
  const terminal = await fixture.route(get("run.camelai.com", "?wait=25"), "legacy-new", { auth: oauth });
  assert.deepEqual(await terminal?.json(), { id: fixture.runId, status: "completed" });
  const retry = await fixture.route(makeRequest({ ...gatewayBody, wait: false }, "agents.camelai.dev", "/v1/runs?wait=1"), "legacy-new");
  assert.deepEqual(await retry?.json(), { id: fixture.runId, status: "completed" });
  assert.deepEqual(fixture.reads, [fixture.runId, fixture.runId]);
  assert.deepEqual(fixture.starts, [fixture.runId, fixture.runId]);
  assert.equal(await fixture.route(makeRequest(gatewayBody, undefined, undefined, {
    "idempotency-key": "61b85bb6-fa0b-473a-8f7d-b702f1c24b8e",
  }), "native-new", { auth: oauth }), null);
  assert.equal(fixture.starts.length, 2);
});

test("a legacy proposal that wins during the Postgres check prevents native dispatch", async () => {
  const fixture = routeFixture();
  let inspecting!: () => void;
  const entered = new Promise<void>(resolve => { inspecting = resolve; });
  let finish!: (result: boolean) => void;
  fixture.exists(() => new Promise(resolve => { finish = resolve; inspecting(); }));
  const first = fixture.route(makeRequest(gatewayBody), "native-new");
  await entered;
  assert.equal(await fixture.route(makeRequest(gatewayBody, "agents.camelai.dev"), "legacy-new"), null);
  finish(false);
  assert.equal(await first, null);
  assert.deepEqual(fixture.starts, []);
});
