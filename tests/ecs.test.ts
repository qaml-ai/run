import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { nodeLoadLine, nodeUrl } from "../src/ecs.ts";
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

test("the node address is AGENT_NODE_URL, else the ECS task's private IPv4, else loopback", async t => {
  assert.equal(await nodeUrl({ AGENT_NODE_URL: "http://10.0.0.9:8790/", ECS_CONTAINER_METADATA_URI_V4: "http://127.0.0.1:1" }, 8790), "http://10.0.0.9:8790");
  assert.equal(await nodeUrl({}, 8123), "http://127.0.0.1:8123");
  assert.equal(await nodeUrl({ PORT: "8124" }), "http://127.0.0.1:8124");

  let metadata: unknown = {
    DockerId: "ea32192c8553fbff06c9340478a2ff089b2bb5646fb718b4ee206641c9086d66", Name: "runtime",
    Networks: [{ NetworkMode: "awsvpc", IPv4Addresses: ["10.0.2.106"], AttachmentIndex: 0, IPv4SubnetCIDRBlock: "10.0.2.0/24", PrivateDNSName: "ip-10-0-2-106.us-west-2.compute.internal" }],
  };
  let status = 200;
  const paths: string[] = [];
  const endpoint = await fake(t, (req, res) => { paths.push(req.url!); res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(metadata)); });
  const ecs = { ECS_CONTAINER_METADATA_URI_V4: `${endpoint}/v4/0123`, PORT: "8790" };
  assert.equal(await nodeUrl(ecs), "http://10.0.2.106:8790");
  assert.deepEqual(paths, ["/v4/0123"], "the container's own metadata, not the task's");

  metadata = { Networks: [{ NetworkMode: "awsvpc", IPv4Addresses: [] }] };
  await assert.rejects(nodeUrl(ecs), /no private IPv4 address; set AGENT_NODE_URL/);
  status = 500;
  await assert.rejects(nodeUrl(ecs), /HTTP 500/);
});

test("node load is a CloudWatch Embedded Metric Format line", () => {
  const load = { agents: 3, volumes: 2, runningTurns: 1, rssBytes: 123_456_789 };
  const line = JSON.parse(nodeLoadLine(load, undefined, { node: "http://10.0.2.106:8790" }, 1_700_000_000_000));
  assert.deepEqual(line, {
    _aws: {
      Timestamp: 1_700_000_000_000,
      CloudWatchMetrics: [{
        Namespace: "AgentRuntime", Dimensions: [[]],
        Metrics: [{ Name: "agents", Unit: "Count" }, { Name: "volumes", Unit: "Count" }, { Name: "runningTurns", Unit: "Count" }, { Name: "rssBytes", Unit: "Bytes" }],
      }],
    },
    type: "node_load", node: "http://10.0.2.106:8790", ...load,
  });
  const named = JSON.parse(nodeLoadLine(load, "agent-runtime"));
  assert.deepEqual(named._aws.CloudWatchMetrics[0].Dimensions, [["ServiceName"]]);
  assert.equal(named.ServiceName, "agent-runtime", "every dimension is a field of the line");
});

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
