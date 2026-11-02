// aws-mcp-proxy: an MCP server on a Lambda Function URL. One tool, `aws_read`, signed with the
// function's own role. Callers hold a shared secret; the function holds only its SHA-256.
//
// No dependencies: SigV4 by hand over node:crypto, MCP over JSON on POST /mcp (Streamable HTTP,
// stateless), and fetch (node 18+). Read-only.ts's rules live in READ_ONLY below.
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

/** Operations refused whatever they are called: each returns a credential, a secret's value, or an object's bytes. */
const NEVER = new Set([
  "sts:assumerole", "sts:getsessiontoken", "sts:getfederationtoken",
  "secretsmanager:getsecretvalue", "ssm:getparameter", "ssm:getparameters", "ssm:getparametersbypath",
  "kms:decrypt", "kms:generatedatakey", "kms:generatedatakeywithoutplaintext",
  "s3:getobject", "s3:selectobjectcontent",
  "ec2:getpassworddata", "ec2:getconsoleoutput", "lambda:getfunction", "iam:createaccesskey",
  "ecr:getauthorizationtoken", "codeartifact:getauthorizationtoken",
]);
const READ = ["Describe", "List", "Get", "Head", "Search", "Lookup", "Check", "Test", "Validate", "Simulate", "Estimate", "Preview", "Query", "Scan"];

/** The protocols this proxy speaks, by IAM service name. */
const PROTOCOL = {
  ec2: { kind: "query", version: "2016-11-15" },
  sts: { kind: "query", version: "2011-06-15" },
  iam: { kind: "query", version: "2010-05-08" },
  cloudwatch: { kind: "query", version: "2010-08-01" },
  logs: { kind: "json", target: "Logs_20140328" },
  ecs: { kind: "json", target: "AmazonEC2ContainerServiceV20141113" },
};

export function verdict(service, operation) {
  if (NEVER.has(`${service.toLowerCase()}:${operation.toLowerCase()}`)) return `This proxy never calls ${service}:${operation}: it returns credentials, a secret or object data`;
  if (!/^[A-Z][A-Za-z0-9]*$/.test(operation)) return `Not an AWS operation name: ${operation}`;
  if (!READ.some(prefix => operation.startsWith(prefix))) return `${service}:${operation} changes things; this proxy calls read-only operations`;
  if (!Object.hasOwn(PROTOCOL, service)) return `This proxy does not speak ${service}: known are ${Object.keys(PROTOCOL).join(", ")}`;
  return undefined;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const HEX = (bytes) => Buffer.from(bytes).toString("hex");

/**
 * Where the IAM service name differs from the endpoint host and from the SigV4 signing name.
 * CloudWatch is both: `monitoring.<region>.amazonaws.com`, scope `monitoring` — sign it as
 * `cloudwatch` and AWS answers SignatureDoesNotMatch.
 */
const ENDPOINT = { cloudwatch: "monitoring" };
const signingService = (service) => ENDPOINT[service] ?? service;

/** SigV4 for one request. Verified against botocore; see test.mjs. */
export function sign({ method, host, path, body, headers, credentials, region, service, now }) {
  const date = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const signed = { ...headers, host, "x-amz-date": date, ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}) };
  const names = Object.keys(signed).sort();
  const canonical = [
    method, path, "",
    ...names.map(name => `${name}:${String(signed[name]).trim()}`), "",
    names.join(";"), sha256(body),
  ].join("\n");
  const scope = `${date.slice(0, 8)}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n");
  let key = `AWS4${credentials.secretAccessKey}`;
  for (const part of [date.slice(0, 8), region, service, "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...Object.fromEntries(Object.entries(signed).filter(([name]) => name !== "host")),
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

/** One read call with the function's own credentials, which the Lambda runtime puts in the environment. */
async function callAws({ service, operation, params, region }) {
  const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
  if (!credentials.accessKeyId) throw new Error("No credentials in the environment: the function's role is not configured");
  const protocol = PROTOCOL[service];
  const endpoint = new URL(`https://${ENDPOINT[service] ?? service}.${region}.amazonaws.com`);
  const body = protocol.kind === "query"
    ? new URLSearchParams({ Action: operation, Version: protocol.version, ...flat(params) }).toString()
    : JSON.stringify(params ?? {});
  const headers = protocol.kind === "query"
    ? { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }
    : { "content-type": "application/x-amz-json-1.1", "x-amz-target": `${protocol.target}.${operation}` };
  const signed = sign({ method: "POST", host: endpoint.host, path: "/", body, headers, credentials, region, service: signingService(service), now: new Date() });
  const response = await fetch(endpoint, { method: "POST", headers: signed, body, signal: AbortSignal.timeout(25_000) });
  const text = await response.text();
  return { status: response.status, body: text.length > 18_000 ? `${text.slice(0, 18_000)}\n[clipped: ${text.length} characters from AWS]` : text };
}

/** Query parameters are flat: a list is `Key.member.1=a&Key.member.2=b`, not a JSON array. */
function flat(params = {}) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((entry, index) => { out[`${key}.member.${index + 1}`] = typeof entry === "object" ? JSON.stringify(entry) : String(entry); });
    else out[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return out;
}

/**
 * Writes are opt-in (`ALLOW_WRITES=1`) and limited to this list: the least destructive verbs, each with
 * the parameters that make it reversible or inert. Anything else is refused by name.
 *   cloudwatch:PutMetricAlarm   creates an alarm; DeleteAlarms removes it
 *   cloudwatch:DeleteAlarms     the undo
 *   ec2:RunInstances            only with DryRun=true: exercises authorization, creates nothing
 */
const WRITES = new Map([
  ["cloudwatch:putmetricalarm", "Creates a metric alarm"],
  ["cloudwatch:deletealarms", "Deletes alarms by name"],
  ["ec2:runinstances", "Only with DryRun=true: authorizes without creating anything"],
]);
const allowWrites = () => process.env.ALLOW_WRITES === "1";

/** Why a write may not run, or undefined. Applied before anything is signed. */
export function writeVerdict(service, operation, params = {}) {
  if (!WRITES.has(`${service.toLowerCase()}:${operation.toLowerCase()}`)) return `This proxy does not write ${service}:${operation}: writable are ${[...WRITES.keys()].join(", ")}`;
  if (!Object.hasOwn(PROTOCOL, service)) return `This proxy does not speak ${service}`;
  if (service === "ec2" && operation === "RunInstances" && params.DryRun !== "true" && params.DryRun !== true) {
    return "ec2:RunInstances is allowed only with DryRun=true (this proxy does not create instances)";
  }
  return undefined;
}

/** The digest a caller must echo back: one exact action, parameters included. */
export const digestOf = (service, operation, params) => sha256(JSON.stringify({ service, operation, params: params ?? {} }));

const READ_TOOL = {
  name: "aws_read",
  description: "Read one AWS API. Read-only operations only; those returning credentials, secrets or object data are refused.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["service", "operation"],
    properties: {
      service: { type: "string", description: `One of: ${Object.keys(PROTOCOL).join(", ")}` },
      operation: { type: "string", description: "An operation that reads, in PascalCase, e.g. DescribeInstances" },
      params: { type: "object", additionalProperties: true, description: "The operation's parameters, as AWS names them" },
      region: { type: "string", description: `Defaults to ${process.env.AWS_REGION ?? "us-west-2"}` },
    },
  },
};
const WRITE_TOOL = {
  name: "aws_write",
  description: "Change one AWS thing, in two steps: call without `confirm` to see exactly what would run and the digest to send back; call again with that `confirm` to do it.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["service", "operation"],
    properties: {
      service: { type: "string" }, operation: { type: "string" },
      params: { type: "object", additionalProperties: true },
      confirm: { type: "string", description: "The digest returned by the step without it" },
    },
  },
};
const toolsFor = () => allowWrites() ? [READ_TOOL, WRITE_TOOL] : [READ_TOOL];

/**
 * Who is calling. Two doors, and the runtime's token is the one that names someone:
 *
 *  1. A JWT the camelRun runtime signed for this call: 120 seconds, EdDSA, verified against its
 *     published keys, naming the tenant, agent, whom the agent acts for, and who is acting.
 *  2. A shared secret, if one is configured: no identity, kept for clients that are not camelRun
 *     (Claude Desktop, curl, a test).
 *
 * `RUNTIME_TENANTS` is the authorization boundary, not a formality: any tenant can make an agent and
 * point it at this URL, and the runtime signs its tokens too. Only the tenant check tells them apart.
 */
const RUNTIMES = (process.env.RUNTIME_ISSUERS ?? "https://run.camelai.com,https://agents.camelai.dev")
  .split(",").map(value => value.trim().replace(/\/+$/, "")).filter(Boolean);
const TENANTS = (process.env.RUNTIME_TENANTS ?? "").split(",").map(value => value.trim()).filter(Boolean);
const JWKS_URL = process.env.JWKS_URL; // tests: one key set, not looked up per issuer
const AUDIENCES = (process.env.RUNTIME_AUDIENCE ?? "").split(",").map(value => value.trim()).filter(Boolean);

/**
 * What a token must be for. The runtime signs the URL it called unless the definition sets an
 * `audience` name, so the default is this function's own URL, taken from the event. Fail closed: a
 * proxy that cannot say what it is called accepts nobody.
 */
function audiencesFor(event) {
  if (AUDIENCES.length) return AUDIENCES;
  const host = event.requestContext?.domainName ?? event.headers?.host ?? event.headers?.Host;
  return host ? [`https://${host}${event.rawPath ?? "/mcp"}`] : [];
}

const keys = new Map(); // kid -> KeyObject
let keysFetchedAt = 0;

/** The runtime's published keys, cached for ten minutes; an unknown kid fetches again (a rotation). */
async function runtimeKeys(issuer) {
  const fresh = Date.now() - keysFetchedAt < 10 * 60_000;
  if (fresh && keys.size) return keys;
  const url = JWKS_URL ?? `${issuer}/.well-known/jwks.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`The runtime's keys answered HTTP ${response.status} at ${url}`);
  const { keys: published } = await response.json();
  for (const jwk of published ?? []) keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
  keysFetchedAt = Date.now();
  return keys;
}

const b64 = (value) => Buffer.from(value, "base64url");

/** The identity a camelRun token names, or an Error saying why it is not acceptable. */
async function fromRuntimeToken(token, audiences) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Not a JWT");
  const header = JSON.parse(b64(parts[0]).toString("utf8"));
  if (header.alg !== "EdDSA") throw new Error(`Unsupported algorithm ${header.alg}`);
  const claims = JSON.parse(b64(parts[1]).toString("utf8"));
  if (!RUNTIMES.includes(String(claims.iss ?? "").replace(/\/+$/, ""))) throw new Error(`Issuer ${claims.iss} is not the runtime`);
  const audience = [claims.aud].flat();
  if (!audiences.length) throw new Error("This proxy has no audience configured: set RUNTIME_AUDIENCE to its URL or name");
  if (!audience.some(value => audiences.includes(value))) throw new Error(`Token is for ${audience.join(", ")}, not this proxy (${audiences.join(", ")})`);
  if (!(typeof claims.exp === "number" && claims.exp * 1000 > Date.now() - 30_000)) throw new Error("Token has expired");
  const key = (await runtimeKeys(claims.iss)).get(header.kid);
  const signature = b64(parts[2]);
  if (!key || signature.length !== 64 || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) throw new Error("Signature does not verify");
  if (!TENANTS.includes(claims.tenant)) throw new Error(`Tenant ${claims.tenant} is not accepted by this proxy`);
  return { tenant: claims.tenant, agent: claims.agent, subject: claims.sub, actor: claims.act, request: claims.req, call: claims.tcid };
}

/** The identity a shared secret grants: it names no one, so it borrows the tenant the secret is for. */
function fromSecret(token) {
  const expected = process.env.SECRET_SHA256 ?? "";
  if (!expected) return undefined;
  const given = Buffer.from(sha256(token), "hex");
  const want = Buffer.from(expected, "hex");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
  return { tenant: TENANTS[0] ?? "shared", agent: "mcp-secret", subject: undefined, actor: undefined, via: "secret" };
}

async function authenticate(event) {
  const headers = event.headers ?? {};
  const token = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? headers.Authorization ?? "")?.[1]?.trim() ?? "";
  if (!token) return undefined;
  if (token.split(".").length === 3) {
    try { return { ...await fromRuntimeToken(token, audiencesFor(event)), via: "runtime" }; }
    catch (error) { authError = error instanceof Error ? error.message : String(error); return undefined; }
  }
  return fromSecret(token);
}

/** Why the last authentication failed, for the 401's words (never the token itself). */
let authError = "";

/** Attempts already applied, by the runtime's idempotency key. Per process: a warm Lambda keeps it, a cold one does not. */
const done = new Map();

const json = (statusCode, value) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const rpc = (id, result) => json(200, { jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => json(200, { jsonrpc: "2.0", id, error: { code, message } });

export const handler = async (event) => {
  const headers = event.headers ?? {};
  const path = event.rawPath ?? "/";
  if (path === "/health") return json(200, { ok: true, service: "aws-mcp-proxy" });
  const identity = await authenticate(event);
  if (!identity) return json(401, { error: `Unauthorized${authError ? `: ${authError}` : ": send the runtime's token, or the proxy's secret"}` });
  if ((event.requestContext?.http?.method ?? "POST") !== "POST") return json(405, { error: "POST /mcp only" });

  let message;
  try { message = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "{}"); }
  catch { return rpcError(null, -32700, "Parse error"); }

  const id = message.id ?? null;
  if (message.method === "initialize") {
    return rpc(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "aws-mcp-proxy", version: "1.0.0" } });
  }
  if (message.method === "notifications/initialized" || message.method === "ping") return message.method === "ping" ? rpc(id, {}) : { statusCode: 202, body: "" };
  if (message.method === "tools/list") return rpc(id, { tools: toolsFor() });
  if (message.method !== "tools/call") return rpcError(id, -32601, `Unknown method ${message.method}`);

  const name = message.params?.name;
  console.log(JSON.stringify({ type: "aws_proxy_call", tool: name, via: identity.via, tenant: identity.tenant, agent: identity.agent, subject: identity.subject, actor: identity.actor }));
  const args = message.params?.arguments ?? {};
  if (name === "aws_write") {
    if (!allowWrites()) return rpc(id, { content: [{ type: "text", text: "Error: this proxy is read-only (ALLOW_WRITES is not set)" }], isError: true });
    const service = String(args.service ?? "");
    const operation = String(args.operation ?? "");
    const params = args.params ?? {};
    const refusal = writeVerdict(service, operation, params);
    if (refusal) return rpc(id, { content: [{ type: "text", text: `Error: ${refusal}` }], isError: true });
    const digest = digestOf(service, operation, params);
    if (args.confirm === undefined) {
      return rpc(id, { content: [{ type: "text", text: `This would call ${service}:${operation} with ${JSON.stringify(params)}. To do it, call aws_write again with confirm: "${digest}"` }] });
    }
    // A digest that does not match is someone approving a different action: never run it.
    if (args.confirm !== digest) {
      return rpc(id, { content: [{ type: "text", text: `Error: confirm does not match this action. It is ${digest}; the digest sent was ${String(args.confirm).slice(0, 16)}…` }], isError: true });
    }
    // A retry of the same call must not run twice: the runtime's idempotency key names the attempt.
    const key = message.params?._meta?.["agent-runtime/idempotencyKey"];
    if (key && done.has(key)) return rpc(id, { content: [{ type: "text", text: `Already sent for this attempt: ${done.get(key)} (this proxy does not send a write twice for one attempt)` }] });
    try {
      const answer = await callAws({ service, operation, params, region: String(args.region ?? process.env.AWS_REGION ?? "us-west-2") });
      if (key) done.set(key, `HTTP ${answer.status}`);
      return rpc(id, { content: [{ type: "text", text: `HTTP ${answer.status} ${service}:${operation}\n${answer.body}` }], ...(answer.status >= 400 ? { isError: true } : {}) });
    } catch (error) {
      return rpc(id, { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true });
    }
  }
  if (name !== "aws_read") return rpcError(id, -32602, `Unknown tool ${name}`);
  const service = String(args.service ?? "");
  const operation = String(args.operation ?? "");
  const refusal = verdict(service, operation);
  if (refusal) return rpc(id, { content: [{ type: "text", text: `Error: ${refusal}` }], isError: true });
  try {
    const answer = await callAws({ service, operation, params: args.params ?? {}, region: String(args.region ?? process.env.AWS_REGION ?? "us-west-2") });
    return rpc(id, { content: [{ type: "text", text: `HTTP ${answer.status} ${service}:${operation}\n${answer.body}` }], ...(answer.status >= 400 ? { isError: true } : {}) });
  } catch (error) {
    return rpc(id, { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true });
  }
};
