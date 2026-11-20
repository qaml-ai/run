import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Agents } from "../../../clients/agents.ts";
import {
  legacyGatewayTextAccess, legacyGatewayTextInput, legacyGatewayTextPrincipal, readLegacyGatewayText,
} from "../src/legacy-gateway-text.ts";

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
      const access = legacyGatewayTextAccess(request, scope);
      assert.ok(access);
      assert.ok(legacyGatewayTextPrincipal({ kind: "operator", tenantId: tenant, scopes: ["*"], principal: { via: "operator", tenant } }, access));
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

test("other credentials, aliases, tenants and OAuth never select the legacy gateway text adapter", () => {
  assert.equal(legacyGatewayTextAccess(makeRequest(gatewayBody), undefined), null);
  assert.equal(legacyGatewayTextAccess(makeRequest(gatewayBody, "example.test"), scope), null);
  assert.equal(legacyGatewayTextAccess(makeRequest(gatewayBody, "run.camelai.com:8443"), scope), null);
  assert.equal(legacyGatewayTextAccess(makeRequest(gatewayBody, "run.camelai.com", "/v1/runs?wait=1"), scope), null);
  assert.equal(legacyGatewayTextAccess(makeRequest(gatewayBody, undefined, undefined, { authorization: "Bearer foreign" }), scope), null);
  assert.equal(legacyGatewayTextAccess(makeRequest(gatewayBody, undefined, undefined, { "idempotency-key": "historical-key" }), scope), null);
  const access = legacyGatewayTextAccess(makeRequest(gatewayBody), scope)!;
  assert.equal(legacyGatewayTextPrincipal({ kind: "operator", tenantId: "foreign", scopes: ["*"], principal: { tenant: "foreign", via: "operator" } }, access), false);
  assert.equal(legacyGatewayTextPrincipal({ kind: "oauth", tenantId: tenant, scopes: ["*"], principal: { tenant, via: "oauth" } }, access), false);
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
