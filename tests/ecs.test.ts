import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tenantsFromEnvironment } from "../src/tenants.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** A local HTTP server standing in for an AWS endpoint; `handle` sees each request with its body. */
async function fake(t: { after(fn: () => unknown): void }, handle: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    handle(req, res, body);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("tenants load from a Secrets Manager secret, and a bad refresh keeps the last good tenants", async t => {
  const arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:agent-runtime/tenants-AbCdEf";
  let secret = JSON.stringify({ tenants: { alice: { tokenSha256: sha("alice-token"), apiKeys: { anthropic: "sk-alice" } } } });
  const requests: { target?: string; body: any }[] = [];
  const endpoint = await fake(t, (req, res, body) => {
    requests.push({ target: req.headers["x-amz-target"] as string, body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "application/x-amz-json-1.1" }).end(JSON.stringify({ ARN: arn, Name: "agent-runtime/tenants", VersionId: "v1", SecretString: secret }));
  });
  // The SDK takes its endpoint and credentials from the process environment, as on ECS.
  Object.assign(process.env, { AWS_ENDPOINT_URL_SECRETS_MANAGER: endpoint, AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "fixture-secret", AWS_REGION: "us-west-2" });

  const tenants = await tenantsFromEnvironment({ AGENT_TENANTS_SECRET_ARN: arn, AWS_REGION: "us-west-2" });
  assert.equal(tenants.source, "secret");
  assert.equal(tenants.legacy, false);
  assert.deepEqual(requests, [{ target: "secretsmanager.GetSecretValue", body: { SecretId: arn } }]);
  assert.equal(tenants.authenticate("Bearer alice-token")?.id, "alice");
  assert.equal(tenants.apiKey("alice", "anthropic"), "sk-alice");

  secret = "{ not json";
  await assert.rejects(tenants.reload());
  secret = JSON.stringify({ tenants: { "Bad Id": { tokenSha256: sha("x"), apiKeys: {} } } });
  await assert.rejects(tenants.reload(), /Invalid tenant id/);
  assert.equal(tenants.authenticate("Bearer alice-token")?.id, "alice", "the last good tenants stay in force");

  secret = JSON.stringify({ tenants: { bob: { tokenSha256: sha("bob-token"), apiKeys: { "*": "sk-bob" } } } });
  await tenants.reload();
  assert.equal(tenants.authenticate("Bearer alice-token"), undefined);
  assert.equal(tenants.authenticate("Bearer bob-token")?.id, "bob");

  await assert.rejects(tenantsFromEnvironment({ AGENT_TENANTS_SECRET_ARN: arn, AGENT_TENANTS_FILE: "/etc/agent-runtime/tenants.json" }), /not both/);
});
