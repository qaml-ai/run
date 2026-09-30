import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { nodeLoadLine, nodeUrl, supersession, taskAddress, TaskProtection } from "../src/ecs.ts";
import { tenantsFromEnvironment } from "../src/tenants.ts";
import { runtimeSecrets } from "../src/secrets.ts";

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
  assert.equal(await taskAddress({}), undefined);
  assert.equal(nodeUrl({}, 8123), "http://127.0.0.1:8123");

  let metadata: unknown = {
    DockerId: "ea32192c8553fbff06c9340478a2ff089b2bb5646fb718b4ee206641c9086d66", Name: "runtime",
    Networks: [{ NetworkMode: "awsvpc", IPv4Addresses: ["10.0.2.106"], AttachmentIndex: 0, IPv4SubnetCIDRBlock: "10.0.2.0/24", PrivateDNSName: "ip-10-0-2-106.us-west-2.compute.internal" }],
  };
  let status = 200;
  const paths: string[] = [];
  const endpoint = await fake(t, (req, res) => { paths.push(req.url!); res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(metadata)); });
  const ecs = { ECS_CONTAINER_METADATA_URI_V4: `${endpoint}/v4/0123` };
  const address = await taskAddress(ecs);
  assert.equal(address, "10.0.2.106");
  assert.deepEqual(paths, ["/v4/0123"], "the container's own metadata, not the task's");
  assert.equal(nodeUrl(ecs, 8790, address), "http://10.0.2.106:8790");
  assert.equal(nodeUrl({ ...ecs, AGENT_NODE_URL: "http://runtime.internal:8790/" }, 8790, address), "http://runtime.internal:8790");

  metadata = { Networks: [{ NetworkMode: "awsvpc", IPv4Addresses: [] }] };
  await assert.rejects(taskAddress(ecs), /no private IPv4 address; set AGENT_NODE_URL/);
  status = 500;
  await assert.rejects(taskAddress(ecs), /HTTP 500/);
});

test("a task is superseded when the service's primary deployment runs another revision or started after it", async t => {
  const task = { Cluster: "arn:aws:ecs:us-west-2:123456789012:cluster/camelai-agent-runtime", Family: "camelai-agent-runtime", Revision: "7", PullStartedAt: "2026-09-23T10:00:00.000Z" };
  const endpoint = await fake(t, (req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(req.url!.endsWith("/task") ? task : {})));
  const asked: string[][] = [];
  let primary: { taskDefinition?: string; createdAt?: Date; runningCount?: number; desiredCount?: number } | undefined;
  const describe = async (cluster: string, service: string) => { asked.push([cluster, service]); return primary; };
  const env = { ECS_CONTAINER_METADATA_URI_V4: `${endpoint}/v4/0123`, AGENT_ECS_SERVICE: "camelai-agent-runtime" };
  assert.equal(await supersession({ ECS_CONTAINER_METADATA_URI_V4: env.ECS_CONTAINER_METADATA_URI_V4 }, describe), undefined, "no service named: nothing to watch");
  const superseded = (await supersession(env, describe))!;
  const revision = (n: number) => `arn:aws:ecs:us-west-2:123456789012:task-definition/camelai-agent-runtime:${n}`;

  primary = { taskDefinition: revision(7), createdAt: new Date("2026-09-23T09:55:00Z") };
  assert.equal(await superseded(), "current");
  assert.deepEqual(asked[0], [task.Cluster, "camelai-agent-runtime"], "the cluster comes from the task when AGENT_ECS_CLUSTER is unset");
  primary = { taskDefinition: revision(17), createdAt: new Date("2026-09-23T09:55:00Z") };
  assert.equal(await superseded(), "superseded", "revision 17 does not end with :7");
  primary = { taskDefinition: revision(8), createdAt: new Date("2026-09-23T11:00:00Z") };
  assert.equal(await superseded(), "superseded");
  primary = { taskDefinition: revision(7), createdAt: new Date("2026-09-23T11:00:00Z") };
  assert.equal(await superseded(), "superseded", "a forced deployment of the same revision");
  primary = undefined;
  assert.equal(await superseded(), "current");
  await supersession({ ...env, AGENT_ECS_CLUSTER: "other" }, describe).then(check => check!());
  assert.equal(asked.at(-1)![0], "other");
});

test("a superseded task waits for the new deployment to run all its tasks, for at most AGENT_RETIRE_WAIT_MS", async t => {
  const task = { Cluster: "arn:aws:ecs:us-west-2:123456789012:cluster/runtime", Family: "runtime", Revision: "7", PullStartedAt: "2026-09-23T10:00:00.000Z" };
  const endpoint = await fake(t, (req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(req.url!.endsWith("/task") ? task : {})));
  const newer = "arn:aws:ecs:us-west-2:123456789012:task-definition/runtime:8";
  let primary: { taskDefinition: string; createdAt: Date; runningCount?: number; desiredCount?: number } = { taskDefinition: newer, createdAt: new Date("2026-09-23T11:00:00Z"), runningCount: 0, desiredCount: 2 };
  let now = 0;
  const env = { ECS_CONTAINER_METADATA_URI_V4: `${endpoint}/v4/0123`, AGENT_ECS_SERVICE: "runtime" };
  const check = (await supersession(env, async () => primary, { now: () => now }))!;
  assert.equal(await check(), "waiting", "its replacements are not running yet");
  primary = { ...primary, runningCount: 1 };
  now = 60_000;
  assert.equal(await check(), "waiting", "one of two");
  primary = { ...primary, runningCount: 2 };
  assert.equal(await check(), "superseded");
  primary = { ...primary, runningCount: 0 };
  assert.equal(await check(), "waiting");
  now = 10 * 60_000;
  assert.equal(await check(), "superseded", "ten minutes superseded: a stuck deployment does not keep it forever");
  primary = { ...primary, taskDefinition: "arn:aws:ecs:us-west-2:123456789012:task-definition/runtime:7", createdAt: new Date("2026-09-23T09:00:00Z") };
  assert.equal(await check(), "current", "rolled back");
  primary = { ...primary, taskDefinition: newer, createdAt: new Date("2026-09-23T12:00:00Z") };
  assert.equal(await check(), "waiting", "the wait starts again with the next deployment");
  const short = (await supersession({ ...env, AGENT_RETIRE_WAIT_MS: "1000" }, async () => primary, { now: () => now }))!;
  assert.equal(await short(), "waiting");
  now += 1_000;
  assert.equal(await short(), "superseded");
});

test("task protection turns on with work, renews before it expires, and turns off only after a quiet period", async t => {
  const writes: any[] = [];
  let fail = false;
  const endpoint = await fake(t, (req, res, body) => {
    writes.push({ method: req.method, path: req.url, body: JSON.parse(body) });
    if (fail) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ failure: { Arn: "arn", Reason: "TASK_NOT_VALID" } }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ protection: { ProtectionEnabled: true } }));
  });
  let now = 0;
  const protection = new TaskProtection({ uri: `${endpoint}/api/task-1234/`, idleMs: 30_000, expiresMinutes: 60, now: () => now });
  const tick = async (busy: boolean, at: number) => { now = at; await protection.update(busy); };
  const states = () => writes.map(write => write.body.ProtectionEnabled);

  await tick(false, 0);
  assert.deepEqual(writes, [], "idle from the start: nothing to clear");
  await tick(true, 1_000);
  assert.deepEqual(writes[0], { method: "PUT", path: "/api/task-1234/task-protection/v1/state", body: { ProtectionEnabled: true, ExpiresInMinutes: 60 } });
  for (let at = 2_000; at < 60_000; at += 1_000) await tick(at % 20_000 < 10_000, at);
  assert.deepEqual(states(), [true], "gaps shorter than the quiet period never clear it");
  await tick(true, 1_000 + 15 * 60_000);
  assert.deepEqual(states(), [true, true], "renewed a quarter into its lifetime");
  const renewed = 1_000 + 15 * 60_000;
  await tick(false, renewed + 10_000);
  await tick(false, renewed + 29_000);
  assert.deepEqual(states(), [true, true]);
  await tick(false, renewed + 30_000);
  await tick(false, renewed + 90_000);
  assert.deepEqual(states(), [true, true, false], "cleared once, after 30 s without work");
  assert.equal(protection.enabled, false);

  fail = true;
  await tick(true, 20 * 60_000);
  assert.equal(protection.enabled, false, "a refused write is not taken as protection");
  fail = false;
  await tick(true, 20 * 60_000 + 1_000);
  assert.equal(protection.enabled, true, "and is retried on the next tick");

  const off = new TaskProtection({});
  await off.update(true);
  assert.equal(off.enabled, false, "a no-op off ECS");
});

test("node load is a CloudWatch Embedded Metric Format line", () => {
  const load = { hostedAgents: 3, sessions: 5, volumes: 2, runningTurns: 1, rssBytes: 123_456_789 };
  const line = JSON.parse(nodeLoadLine(load, undefined, { node: "http://10.0.2.106:8790" }, 1_700_000_000_000));
  assert.deepEqual(line, {
    _aws: {
      Timestamp: 1_700_000_000_000,
      CloudWatchMetrics: [{
        Namespace: "AgentRuntime", Dimensions: [[]],
        Metrics: [
          { Name: "hostedAgents", Unit: "Count" }, { Name: "sessions", Unit: "Count" },
          { Name: "volumes", Unit: "Count" }, { Name: "runningTurns", Unit: "Count" }, { Name: "rssBytes", Unit: "Bytes" },
        ],
      }],
    },
    type: "node_load", node: "http://10.0.2.106:8790", ...load,
  });
  const named = JSON.parse(nodeLoadLine(load, "agent-runtime"));
  assert.deepEqual(named._aws.CloudWatchMetrics[0].Dimensions, [["ServiceName"]]);
  assert.equal(named.ServiceName, "agent-runtime", "every dimension is a field of the line");
});

test("node load also carries event stream watchers and the database pool, when the node knows them", () => {
  const load = { hostedAgents: 1, sessions: 1, volumes: 0, runningTurns: 0, rssBytes: 1, watchers: 7, dbConnections: 10, dbIdle: 4, dbWaiting: 2 };
  const line = JSON.parse(nodeLoadLine(load, "agent-runtime"));
  const names = line._aws.CloudWatchMetrics[0].Metrics.map((metric: { Name: string }) => metric.Name);
  assert.deepEqual(names.slice(-4), ["watchers", "dbConnections", "dbIdle", "dbWaiting"]);
  assert.equal(line.watchers, 7);
  assert.equal(line.dbWaiting, 2);
});

test("node load reports heap and buffer memory in bytes, when the node gives them", () => {
  const load = { hostedAgents: 0, sessions: 0, volumes: 0, runningTurns: 0, rssBytes: 700, heapUsedBytes: 90, heapTotalBytes: 400, externalBytes: 30, arrayBuffersBytes: 20 };
  const metrics = JSON.parse(nodeLoadLine(load, "agent-runtime"))._aws.CloudWatchMetrics[0].Metrics;
  assert.deepEqual(metrics.slice(-4), ["heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes"].map(Name => ({ Name, Unit: "Bytes" })));
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
  assert.deepEqual(requests, [{ target: "secretsmanager.GetSecretValue", body: { SecretId: arn } }]);
  assert.equal(tenants.authenticate("Bearer alice-token")?.id, "alice");
  assert.equal(tenants.apiKey("alice", "anthropic"), "sk-alice");

  secret = "{ not json";
  await assert.rejects(tenants.reload());
  secret = JSON.stringify({ tenants: { "Bad Id": { tokenSha256: sha("x"), apiKeys: {} } } });
  await assert.rejects(tenants.reload(), /Invalid tenant id/);
  assert.equal(tenants.authenticate("Bearer alice-token")?.id, "alice", "the last good tenants stay in force");

  secret = JSON.stringify({ tenants: { bob: { tokenSha256: sha("bob-token"), apiKeys: { anthropic: "sk-bob" } } } });
  await tenants.reload();
  assert.equal(tenants.authenticate("Bearer alice-token"), undefined);
  assert.equal(tenants.authenticate("Bearer bob-token")?.id, "bob");

  await assert.rejects(tenantsFromEnvironment({ AGENT_TENANTS_SECRET_ARN: arn, AGENT_TENANTS_FILE: "/etc/agent-runtime/tenants.json" }), /Set only one of AGENT_TENANTS_FILE, AGENT_TENANTS_SECRET_ARN/);
});

test("runtime credentials including billing email load once from Secrets Manager ARNs, or from plain values", async t => {
  const arn = (name: string) => `arn:aws:secretsmanager:us-west-2:123456789012:secret:agent-runtime/${name}-AbCdEf`;
  const values: Record<string, string> = {
    [arn("session-secret")]: "s".repeat(64),
    [arn("secrets-key")]: "k".repeat(64),
    [arn("github-oauth")]: JSON.stringify({ clientId: "Iv1.fixture", clientSecret: "github-fixture-secret" }),
    [arn("stripe")]: JSON.stringify({ secretKey: "sk_test_fixture", webhookSecret: "whsec_fixture" }),
    [arn("tool-search")]: "sk-or-fixture\n",
    [arn("billing-email")]: "ab".repeat(32) + "\n",
  };
  const requested: string[] = [];
  const endpoint = await fake(t, (_req, res, body) => {
    const { SecretId } = JSON.parse(body);
    requested.push(SecretId);
    if (!(SecretId in values)) { res.writeHead(400, { "Content-Type": "application/x-amz-json-1.1" }).end(JSON.stringify({ __type: "ResourceNotFoundException", message: "Secrets Manager can't find the specified secret." })); return; }
    res.writeHead(200, { "Content-Type": "application/x-amz-json-1.1" }).end(JSON.stringify({ ARN: SecretId, Name: "x", VersionId: "v1", SecretString: values[SecretId] }));
  });
  Object.assign(process.env, { AWS_ENDPOINT_URL_SECRETS_MANAGER: endpoint, AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "fixture-secret", AWS_REGION: "us-west-2" });
  const env = { AGENT_SESSION_SECRET_ARN: arn("session-secret"), AGENT_SECRETS_KEY_ARN: arn("secrets-key"), AGENT_GITHUB_OAUTH_SECRET_ARN: arn("github-oauth"), AGENT_STRIPE_SECRET_ARN: arn("stripe"), AGENT_TOOL_SEARCH_SECRET_ARN: arn("tool-search"), AGENT_BILLING_EMAIL_SECRET_ARN: arn("billing-email"), AWS_REGION: "us-west-2" };

  assert.deepEqual(await runtimeSecrets(env), {
    sessionSecret: "s".repeat(64), secretsKey: "k".repeat(64), github: { clientId: "Iv1.fixture", clientSecret: "github-fixture-secret" },
    stripe: { secretKey: "sk_test_fixture", webhookSecret: "whsec_fixture" }, toolSearchKey: "sk-or-fixture", billingEmailSecret: "ab".repeat(32),
  });
  assert.deepEqual(requested.sort(), Object.keys(values).sort(), "Each secret is read once");

  assert.deepEqual(await runtimeSecrets({ AGENT_SESSION_SECRET: "plain-session", AGENT_SECRETS_KEY: "plain-key", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", AGENT_TOOL_SEARCH_API_KEY: "sk-or-plain", AGENT_BILLING_EMAIL_SECRET: "cd".repeat(32) }), {
    sessionSecret: "plain-session", secretsKey: "plain-key", github: { clientId: "id", clientSecret: "secret" }, stripe: { secretKey: "sk_test_x", webhookSecret: "whsec_x" }, toolSearchKey: "sk-or-plain", billingEmailSecret: "cd".repeat(32),
  });
  assert.deepEqual(await runtimeSecrets({}), { sessionSecret: undefined, secretsKey: undefined, github: undefined, stripe: undefined, toolSearchKey: undefined, billingEmailSecret: undefined });
  await assert.rejects(runtimeSecrets({ ...env, AGENT_BILLING_EMAIL_SECRET: "ab".repeat(32) }), /AGENT_BILLING_EMAIL_SECRET or AGENT_BILLING_EMAIL_SECRET_ARN, not both/);
  await assert.rejects(runtimeSecrets({ ...env, AGENT_BILLING_EMAIL_SECRET_ARN: arn("billing-email-unset") }), /can't find the specified secret/);
  // So may the tool search key: search then uses the platform's OpenRouter key.
  assert.equal((await runtimeSecrets({ ...env, AGENT_TOOL_SEARCH_SECRET_ARN: arn("tool-search-unset") })).toolSearchKey, null);
  await assert.rejects(runtimeSecrets({ ...env, AGENT_TOOL_SEARCH_API_KEY: "x" }), /AGENT_TOOL_SEARCH_API_KEY or AGENT_TOOL_SEARCH_SECRET_ARN, not both/);
  // The Stripe secret exists before anyone stores its value: purchases stay off rather than the runtime failing to start.
  assert.equal((await runtimeSecrets({ ...env, AGENT_STRIPE_SECRET_ARN: arn("stripe-unset") })).stripe, undefined);
  await assert.rejects(runtimeSecrets({ ...env, STRIPE_SECRET_KEY: "sk_test_x" }), /STRIPE_SECRET_KEY\/STRIPE_WEBHOOK_SECRET or AGENT_STRIPE_SECRET_ARN, not both/);

  await assert.rejects(runtimeSecrets({ ...env, AGENT_SESSION_SECRET: "x".repeat(32) }), /AGENT_SESSION_SECRET or AGENT_SESSION_SECRET_ARN, not both/);
  await assert.rejects(runtimeSecrets({ ...env, AGENT_SECRETS_KEY: "x" }), /AGENT_SECRETS_KEY or AGENT_SECRETS_KEY_ARN, not both/);
  await assert.rejects(runtimeSecrets({ ...env, GITHUB_CLIENT_SECRET: "x" }), /GITHUB_CLIENT_ID\/GITHUB_CLIENT_SECRET or AGENT_GITHUB_OAUTH_SECRET_ARN, not both/);
  values[arn("github-oauth")] = JSON.stringify({ clientId: "Iv1.fixture" });
  await assert.rejects(runtimeSecrets(env), /must hold \{clientId, clientSecret\}/);
  await assert.rejects(runtimeSecrets({ AGENT_SESSION_SECRET_ARN: arn("missing"), AWS_REGION: "us-west-2" }), /can't find the specified secret/);
});
