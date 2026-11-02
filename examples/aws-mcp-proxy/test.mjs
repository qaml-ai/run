// No AWS account needed: botocore (AWS's own signer) checks the proxy's signatures, a stub stands in
// for the service, and a real Ed25519 key set stands in for the runtime's published keys.
//   node --test infra/aws-mcp-proxy/test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

// --- the runtime's keys, served at a local JWKS endpoint, and the config the handler reads at load
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const { privateKey: otherKey } = generateKeyPairSync("ed25519");
const KID = "test-kid";
const jwks = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "EdDSA", use: "sig" }] })));
jwks.listen(0, "127.0.0.1");
await once(jwks, "listening");
process.env.JWKS_URL = `http://127.0.0.1:${(jwks.address()).port}/jwks`;
process.env.RUNTIME_TENANTS = "test";
const SECRET = randomBytes(16).toString("hex");
process.env.SECRET_SHA256 = createHash("sha256").update(SECRET).digest("hex");
process.env.AWS_REGION = "us-west-2";
const { handler, sign, verdict, digestOf } = await import("./handler.mjs");

const CREDS = { accessKeyId: "ASIAOPERATOREXAMPLE", secretAccessKey: "operator-secret-key-example", sessionToken: "operator-session-token" };
process.env.AWS_ACCESS_KEY_ID = CREDS.accessKeyId;
process.env.AWS_SECRET_ACCESS_KEY = CREDS.secretAccessKey;
process.env.AWS_SESSION_TOKEN = CREDS.sessionToken;

/** A token as the runtime signs one: EdDSA over header.claims, 120 seconds by default. */
function mint(overrides = {}, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://run.camelai.com", aud: "https://proxy.test/mcp", sub: "alice", tenant: "test",
    agent: "client_abc", act: "u_1", ctx: { org: "acme" }, req: "run_1", tcid: "call_1",
    iat: now, exp: now + 120, jti: randomBytes(8).toString("hex"), ...overrides,
  };
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: options.kid ?? KID, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = edSign(null, Buffer.from(`${header}.${payload}`), options.key ?? privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function botocore(url, body, headers, service, region, creds = CREDS) {
  const signed = /SignedHeaders=([^,]+)/.exec(headers.authorization)?.[1]?.split(";") ?? [];
  // fetch sets `host` itself from the URL, so it is not in the headers we pass; botocore derives it the same way.
  const subset = Object.fromEntries(signed.map(name => [name, headers[name] ?? (name === "host" ? new URL(url).host : "")]));
  const py = `
import botocore.auth, botocore.awsrequest, botocore.credentials, datetime, json, sys
service, region, url, body, creds, headers = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], json.loads(sys.argv[5]), json.loads(sys.argv[6])
c = botocore.credentials.Credentials(creds["accessKeyId"], creds["secretAccessKey"], creds.get("sessionToken"))
req = botocore.awsrequest.AWSRequest(method="POST", url=url, data=body, headers=headers)
# add_auth reads the clock itself; freeze it at the timestamp the proxy signed with.
botocore.auth.get_current_datetime = lambda: datetime.datetime.strptime(headers["x-amz-date"], "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
s = botocore.auth.SigV4Auth(c, service, region)
s.add_auth(req)
print(req.headers["Authorization"])
`;
  return execFileSync("python3", ["-c", py, service, region, url, body, JSON.stringify(creds), JSON.stringify(subset)], { encoding: "utf8" }).trim();
}

const event = (body, { path = "/mcp", authorization = `Bearer ${SECRET}` } = {}) => ({
  rawPath: path, headers: { authorization, "content-type": "application/json", host: "proxy.test" }, body: JSON.stringify(body), isBase64Encoded: false,
  // A Function URL event names its own host here; the proxy takes its audience from it.
  requestContext: { domainName: "proxy.test", http: { method: "POST" } },
});
const call = async (body, options) => { const r = await handler(event(body, options)); return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined }; };
const withToken = (token) => ({ authorization: `Bearer ${token}` });
const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

// --- signatures

test("signatures are byte-identical to botocore's", () => {
  const body = "Action=DescribeInstances&Version=2016-11-15";
  const headers = sign({ method: "POST", host: "ec2.us-west-2.amazonaws.com", path: "/", body, headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, credentials: CREDS, region: "us-west-2", service: "ec2", now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(headers.authorization, botocore("https://ec2.us-west-2.amazonaws.com/", body, headers, "ec2", "us-west-2"));
});

// --- who may call

test("the runtime's token is accepted, and its identity reaches the call", async () => {
  const lines = [];
  const real = console.log;
  console.log = (line) => lines.push(line);
  try {
    const result = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aws_read", arguments: { service: "ec2", operation: "TerminateInstances" } } }, withToken(mint()));
    assert.equal(result.status, 200, "the token authenticated"); // refused as a write, but only after authenticating
  } finally { console.log = real; }
  const seen = lines.map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(entry => entry?.type === "aws_proxy_call");
  assert.deepEqual([seen.via, seen.tenant, seen.agent, seen.subject, seen.actor], ["runtime", "test", "client_abc", "alice", "u_1"]);
});

test("a token for another audience, tenant, or a stale one is refused, and says why", async () => {
  const wrongAudience = await call(list, withToken(mint({ aud: "https://elsewhere.test/mcp" })));
  assert.equal(wrongAudience.status, 401);
  assert.match(wrongAudience.json.error, /not this proxy/);

  const wrongTenant = await call(list, withToken(mint({ tenant: "somebody-else" })));
  assert.equal(wrongTenant.status, 401);
  assert.match(wrongTenant.json.error, /not accepted by this proxy/);

  const expired = await call(list, withToken(mint({ exp: Math.floor(Date.now() / 1000) - 300 })));
  assert.equal(expired.status, 401);
  assert.match(expired.json.error, /expired/);
});

test("a token signed by another key, or naming another issuer, is refused", async () => {
  const forged = await call(list, withToken(mint({}, { key: otherKey })));
  assert.equal(forged.status, 401);
  assert.match(forged.json.error, /Signature does not verify/);

  const stranger = await call(list, withToken(mint({ iss: "https://not-the-runtime.test" })));
  assert.equal(stranger.status, 401);
  assert.match(stranger.json.error, /is not the runtime/);
});

test("the shared secret still works for clients that are not camelRun", async () => {
  assert.equal((await call(list)).status, 200, "the secret authenticates");
  assert.equal((await call(list, { authorization: "" })).status, 401);
  assert.equal((await call(list, { authorization: "Bearer wrong" })).status, 401);
});

// --- the MCP surface

test("the MCP handshake and the tool list", async () => {
  const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(init.json.result.serverInfo.name, "aws-mcp-proxy");
  const tools = await call(list);
  assert.deepEqual(tools.json.result.tools.map(tool => tool.name), ["aws_read"]);
});

test("reads, writes and credential-shaped reads are told apart", () => {
  assert.equal(verdict("ec2", "DescribeInstances"), undefined);
  assert.match(verdict("ec2", "TerminateInstances"), /changes things/);
  assert.match(verdict("ssm", "GetParameter"), /never calls/);
  assert.match(verdict("kms", "ListKeys"), /does not speak kms/);
});

test("a read goes out signed, and AWS's signer accepts it", async () => {
  const real = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value]));
    seen = { url: String(url), body: init.body, headers, verified: botocore(String(url), init.body, headers, "sts", "us-west-2") === headers.authorization };
    return new Response("<GetCallerIdentityResponse><Arn>arn:aws:iam::111122223333:user/agent</Arn></GetCallerIdentityResponse>", { status: 200 });
  };
  try {
    const result = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "aws_read", arguments: { service: "sts", operation: "GetCallerIdentity" } } });
    assert.match(result.json.result.content[0].text, /arn:aws:iam::111122223333:user\/agent/);
    assert.ok(seen.verified, "botocore accepts the signature the proxy made");
    assert.match(seen.body, /Action=GetCallerIdentity/);
  } finally { globalThis.fetch = real; }
});

test("cloudwatch is called at monitoring, and signed under that name", async () => {
  const real = globalThis.fetch;
  let host, authorization;
  globalThis.fetch = async (url, init) => { host = new URL(String(url)).host; authorization = init.headers.authorization; return new Response("<ok/>", { status: 200 }); };
  try {
    await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "aws_read", arguments: { service: "cloudwatch", operation: "DescribeAlarms" } } });
    assert.equal(host, "monitoring.us-west-2.amazonaws.com");
    assert.equal(/Credential=[^/]+\/\d{8}\/[^/]+\/([^/]+)\//.exec(authorization)?.[1], "monitoring", "signed under its signing name, not the IAM service name");
  } finally { globalThis.fetch = real; }
});

test("ec2 lists of structures become Filter.N.Name and Filter.N.Value.M", async () => {
  const real = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => { sent = init.body; return new Response("<ok/>", { status: 200 }); };
  try {
    await call({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "aws_read", arguments: {
      service: "ec2", operation: "DescribeInstances",
      params: { Filters: [{ Name: "instance-state-name", Values: ["running", "pending"] }, { Name: "tag:env", Values: ["prod"] }] },
    } } });
    assert.match(sent, /Filter\.1\.Name=instance-state-name/);
    assert.match(sent, /Filter\.1\.Value\.1=running/);
    assert.match(sent, /Filter\.1\.Value\.2=pending/);
    assert.match(sent, /Filter\.2\.Name=tag%3Aenv/);
    assert.ok(!sent.includes("member"), "EC2 takes no member in its lists");
  } finally { globalThis.fetch = real; }
});

test("query parameters carry lists as member.N, as AWS expects", async () => {
  const real = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => { sent = init.body; return new Response("<ok/>", { status: 200 }); };
  try {
    await call({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "aws_read", arguments: { service: "cloudwatch", operation: "DescribeAlarms", params: { AlarmNames: ["a", "b"] } } } });
    assert.match(sent, /AlarmNames\.member\.1=a/);
    assert.match(sent, /AlarmNames\.member\.2=b/);
    assert.ok(!sent.includes("["), "no JSON array reaches a query API");
  } finally { globalThis.fetch = real; }
});

test("a refused call never reaches AWS", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("should not be called"); };
  try {
    const result = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "aws_read", arguments: { service: "ec2", operation: "TerminateInstances" } } });
    assert.equal(result.json.result.isError, true);
    assert.match(result.json.result.content[0].text, /changes things/);
  } finally { globalThis.fetch = real; }
});

// --- writes

test("a write needs the digest back, and only allowlisted operations get one", async () => {
  process.env.ALLOW_WRITES = "1";
  const { writeVerdict } = await import("./handler.mjs");
  assert.match(writeVerdict("ec2", "TerminateInstances", {}), /does not write/);
  assert.match(writeVerdict("ec2", "RunInstances", { DryRun: "false" }), /only with DryRun=true/);
  assert.equal(writeVerdict("ec2", "RunInstances", { DryRun: "true" }), undefined);
  assert.equal(writeVerdict("cloudwatch", "PutMetricAlarm", {}), undefined);

  const preview = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "aws_write", arguments: { service: "cloudwatch", operation: "DeleteAlarms", params: { AlarmNames: ["x"] } } } });
  assert.match(preview.json.result.content[0].text, /confirm: "[0-9a-f]{64}"/);

  const wrong = await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "aws_write", arguments: { service: "cloudwatch", operation: "DeleteAlarms", params: { AlarmNames: ["x"] }, confirm: "00" } } });
  assert.equal(wrong.json.result.isError, true);

  assert.equal(typeof digestOf("cloudwatch", "DeleteAlarms", {}), "string");
  delete process.env.ALLOW_WRITES;
});

test.after(() => jwks.close());

test("a query answer comes back as compact JSON, and a long one drops items instead of cutting text", async () => {
  const real = globalThis.fetch;
  const item = "<item><instanceId>i-0aeccdd21e8547361</instanceId><instanceState><code>16</code><name>running</name></instanceState><privateDnsName></privateDnsName></item>";
  globalThis.fetch = async () => new Response(
    `<DescribeInstancesResponse xmlns="x"><requestId>r1</requestId><reservationSet>${item.repeat(400)}</reservationSet><nextToken>abc123</nextToken></DescribeInstancesResponse>`,
    { status: 200 },
  );
  try {
    const result = await call({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "aws_read", arguments: { service: "ec2", operation: "DescribeInstances" } } });
    const body = result.json.result.content[0].text;
    const json = JSON.parse(body.slice(body.indexOf("\n") + 1));
    assert.ok(!body.includes("<item>"), "no XML reaches the model");
    assert.ok(body.length < 26_000, "still inside the clip");
    assert.equal(json.nextToken, "abc123", "the cursor survives");
    assert.match(json.continueWith, /NextToken/);
    assert.match(json.clipped, /of the \d+ items in this page/, "it is shortened by dropping items, not characters");
    assert.ok(json.reservationSet.length > 100, `it keeps as many items as fit, kept ${json.reservationSet?.length}`);
    assert.ok(Array.isArray(json.reservationSet) && json.reservationSet.length > 0, "some items remain");
    assert.ok(!("requestId" in json), "request ids are dropped");
  } finally { globalThis.fetch = real; }
});
