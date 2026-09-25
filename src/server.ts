import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSupervisor, type Hosting } from "./supervisor.ts";
import { configuredModel } from "./model.ts";
import { errorText } from "./protocol.ts";
import { sessionConfig } from "./session-config.ts";
import { ClientSessions } from "./client-sessions.ts";
import { openStorage, storageFromEnvironment } from "../shared/storage-config.ts";
import { StorageUsage } from "./storage-usage.ts";
import { postgresTail, sweepTails } from "./log-tail.ts";
import { databaseFromEnvironment, migrate } from "./db.ts";
import { Ownership } from "./ownership.ts";
import { tenantsFromEnvironment } from "./tenants.ts";
import { Accounts } from "./accounts.ts";
import { ConsoleAuth } from "./console-auth.ts";
import { api } from "./api.ts";
import { Scheduler } from "./scheduler.ts";
import { Channels } from "./channels.ts";
import { Definitions, sources, validTtl } from "./definitions.ts";
import { outboundFromEnvironment } from "./outbound.ts";
import { McpConnections } from "./mcp.ts";
import { ToolSources } from "./tool-sources.ts";
import { applicationTools } from "./mcp-results.ts";
import { telegram } from "./channels-telegram.ts";
import { slack } from "./channels-slack.ts";
import { discord } from "./channels-discord.ts";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { errorStatus, HttpError, readJson, readText } from "./http.ts";
import { VersionConflict, VolumeService } from "./volumes.ts";
import { nodeLoadLine, nodeUrl, supersession, taskAddress, TaskProtection } from "./ecs.ts";
import { runtimeSecrets } from "./secrets.ts";
import { checkSandbox } from "./codemode.ts";
import { pricingFromEnvironment } from "./pricing.ts";
import { searchProvidersFromEnvironment, WebSearch } from "./web-search.ts";
import { WebRender } from "./web-render.ts";
import { Stripe } from "./stripe.ts";
import { identityInput, RuntimeSigner } from "./identity.ts";
import { rerankersFromEnv } from "./tool-search.ts";

// Tenants (operator token hashes and provider keys) come from AGENT_TENANTS_FILE or AGENT_TENANTS_SECRET_ARN.
const tenants = await tenantsFromEnvironment();
const secrets = await runtimeSecrets();
// Derives client session tokens. It must stay stable, or re-provisioning returns tokens that no longer verify.
const sessionSecret = secrets.sessionSecret;
if (!sessionSecret || sessionSecret.length < 32) throw new Error("Set AGENT_SESSION_SECRET (or AGENT_SESSION_SECRET_ARN) to at least 32 random characters");
const root = resolve(process.env.AGENT_DATA_DIR ?? ".agent-runtime");
/** A positive integer setting. */
function positiveSetting(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
// Agents hosted per node and per tenant on a node: processes with AGENT_HOSTING=process, in-process hosts with inline.
const maxAgents = positiveSetting("AGENT_MAX_AGENTS", 8);
const maxAgentsPerTenant = positiveSetting("AGENT_MAX_AGENTS_PER_TENANT", Math.max(1, Math.ceil(maxAgents / 2)));
const port = Number(process.env.PORT ?? 8790);
const drainMs = Number(process.env.AGENT_DRAIN_TIMEOUT_MS ?? 100_000);
if (!Number.isInteger(drainMs) || drainMs < 0) throw new Error("AGENT_DRAIN_TIMEOUT_MS must be a non-negative integer");
const retireMaxMs = Number(process.env.AGENT_RETIRE_MAX_MS ?? 6 * 60 * 60_000);
if (!Number.isInteger(retireMaxMs) || retireMaxMs < 0) throw new Error("AGENT_RETIRE_MAX_MS must be a non-negative integer");
// Where js_exec runs, reported in the "listening" line; fails startup if isolation is required but absent.
const sandbox = await checkSandbox();
// How tools.search ranks: keywords alone, or fused with the operator's rerank stages.
// The key: a dedicated one if set (AGENT_TOOL_SEARCH_API_KEY, or the tool-search secret), else the
// platform's OpenRouter key from the tenants file, read at each search so a reload takes effect.
const platformOpenRouter = () => tenants.platformKey("openrouter");
const rerankers = rerankersFromEnv(process.env, secrets.toolSearchKey || platformOpenRouter);
if (rerankers.length && !secrets.toolSearchKey && !platformOpenRouter()) {
  console.error(JSON.stringify({ type: "tool_search_not_configured", reason: "no platformKeys.openrouter in the tenants file and no AGENT_TOOL_SEARCH_API_KEY; tools.search ranks by keywords until one is set" }));
}
// Control plane: coordination and small mutable state in Postgres.
const db = await databaseFromEnvironment();
await migrate(db);
// Data plane: logs and blobs in local files by default, or shared storage (S3) so any node can serve any agent.
// Shared logs keep their recent records in Postgres until they are compacted into Storage.
const storageDescriptor = storageFromEnvironment(root);
const leaseTtlMs = Number(process.env.AGENT_LEASE_TTL_MS ?? 90_000);
// A durable flush while the database is away waits up to a lease for it; by then the node has fenced anyway.
// What each agent, volume and tenant stores is tracked as objects are written and deleted, for the storage charge.
const storageUsage = new StorageUsage(db);
const storage = await openStorage(storageDescriptor, postgresTail(db, { retryMs: leaseTtlMs }), storageUsage.meter);
const distributed = storageDescriptor.kind === "s3" || !!(storageDescriptor.kind === "file" && storageDescriptor.shared);
const address = await taskAddress();
const node = nodeUrl(process.env, port, address);
const ownership = new Ownership(db, { node, ttlMs: leaseTtlMs });
await ownership.start();
// Local files are this host's alone: a second node on the same database would serve agents and volumes whose
// logs it cannot see, with nothing to fence its writes. Wait out a peer that may have just died, then refuse.
if (!distributed) {
  for (const deadline = Date.now() + leaseTtlMs; ;) {
    const peers = await ownership.livePeers();
    if (!peers.length) break;
    if (Date.now() >= deadline) throw new Error(`AGENT_STORAGE=file is for one node, but other nodes share this database (${peers.join(", ")}); use shared-file or s3 for several nodes`);
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}
const hosting = (process.env.AGENT_HOSTING ?? "process") as Hosting;
if (!["process", "inline"].includes(hosting)) throw new Error("AGENT_HOSTING must be process or inline");
const supervisor = new AgentSupervisor(join(root, "sessions"), { runtime: process.env.AGENT_RUNTIME, maxAgents, hosting, ...(distributed ? { storage } : {}) });
const model = configuredModel();
const toolTimeoutMs = Number(process.env.AGENT_TOOL_TIMEOUT_MS ?? 15_000);
if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 15 * 60_000) throw new Error("AGENT_TOOL_TIMEOUT_MS must be an integer between 1 and 900000");
const idleMs = Number(process.env.AGENT_IDLE_MS ?? 5 * 60_000);
if (!Number.isInteger(idleMs) || idleMs < 1000) throw new Error("AGENT_IDLE_MS must be an integer of at least 1000");
// Endpoints beyond the default model's and Pi's published ones that may receive a provider key.
const allowedBaseUrls = (process.env.AGENT_ALLOWED_BASE_URLS ?? "").split(",").map(value => value.trim()).filter(Boolean);
const publicUrl = (process.env.AGENT_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
// Tenant-set provider keys are encrypted with AGENT_SECRETS_KEY; without it tenants cannot store keys.
// Prepaid tenants pay from credit at the rates in src/pricing.ts, which the environment may override.
// Credit is bought through Stripe Checkout when Stripe is configured (AGENT_STRIPE_SECRET_ARN, or STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET).
const stripe = secrets.stripe && new Stripe({ ...secrets.stripe, apiUrl: process.env.AGENT_STRIPE_API_URL });
const accounts = new Accounts({ tenants, db, secretsKey: secrets.secretsKey, pricing: pricingFromEnvironment(), publicUrl, stripe });
// GitHub sign-in admits members of GITHUB_ORG, or with AGENT_OPEN_SIGNUP=true anyone; starting credit needs an account
// AGENT_SIGNUP_MIN_ACCOUNT_DAYS (default 30) old.
const minAccountDays = Number(process.env.AGENT_SIGNUP_MIN_ACCOUNT_DAYS ?? 30);
if (!Number.isFinite(minAccountDays) || minAccountDays < 0) throw new Error("AGENT_SIGNUP_MIN_ACCOUNT_DAYS must be a non-negative number of days");
const github = secrets.github && {
  ...secrets.github, org: process.env.GITHUB_ORG ?? "qaml-ai", open: process.env.AGENT_OPEN_SIGNUP === "true", minAccountDays,
  webUrl: process.env.AGENT_GITHUB_WEB_URL, apiUrl: process.env.AGENT_GITHUB_API_URL,
};
const consoleAuth = new ConsoleAuth({ accounts, secret: sessionSecret, publicUrl, github });
const consoleDir = resolve(process.env.AGENT_CONSOLE_DIR ?? fileURLToPath(new URL("../console/dist", import.meta.url)));

// Every call to a URL a tenant configured (MCP servers, web_fetch) goes through one guard: public addresses only.
const outbound = outboundFromEnvironment();
const mcp = new McpConnections({ outbound });
// Identity tokens for tool servers with auth "runtime", verified against /.well-known/jwks.json.
const signer = new RuntimeSigner({ db, accounts, issuer: publicUrl });
// web_search and web_fetch's renderer: the tenant's key for each provider, else an admin's, else (prepaid) the
// platform's, whose calls are charged to credit at that provider's price.
const webKey = async (tenant: string, provider: string) => {
  const resolved = await accounts.providerKey(tenant, provider);
  return resolved && { key: resolved.key, platform: resolved.source !== "tenant" };
};
const searchTimeoutMs = Number(process.env.AGENT_WEB_SEARCH_TIMEOUT_MS ?? 5_000);
if (!Number.isInteger(searchTimeoutMs) || searchTimeoutMs < 100 || searchTimeoutMs > 60_000) throw new Error("AGENT_WEB_SEARCH_TIMEOUT_MS must be an integer between 100 and 60000");
const search = new WebSearch({
  outbound, ...searchProvidersFromEnvironment(), key: webKey, timeoutMs: searchTimeoutMs,
  price: provider => accounts.billing.pricing.webSearch[provider],
  onSearch: (tenant, agent, usage) => accounts.recordUsage(tenant, agent, usage),
});
const render = new WebRender({
  outbound, key: webKey, price: accounts.billing.pricing.webRender, endpoint: process.env.AGENT_FIRECRAWL_SCRAPE_URL,
  onRender: (tenant, agent, usage) => accounts.recordUsage(tenant, agent, usage),
});
const toolSources = new ToolSources({ accounts, mcp, outbound, signer, search, render, get scheduler() { return scheduler; } });
const definitions = new Definitions({ db, accounts, outbound });

/** Provision an agent for `tenant`: the shared path behind POST /client-sessions and POST /v1/agents. */
async function createAgent(tenant: string, params: any, key?: string) {
  // The application's tools are its attached MCP server's: the tools/list it declares.
  const { mcp: _mcp, subject: _subject, context: _context, ...rest } = params ?? {};
  // Who the agent acts for, and context for its tool servers' identity tokens.
  const identity = identityInput(params ?? {});
  try { params = { ...rest, tools: applicationTools(params ?? {}) }; } catch (error) { throw new HttpError(400, errorText(error)); }
  const made = params?.definition !== undefined ? await definitions.provision(tenant, params) : undefined;
  if (made) params = made.params;
  const config = sessionConfig(params, model, process.env.AGENT_SYSTEM_PROMPT, allowedBaseUrls);
  if (!await accounts.hasKey(tenant, config.model.provider)) {
    throw new Error(`No ${config.model.provider} API key is configured for tenant ${tenant}; set one with PUT /v1/providers/${config.model.provider}/key`);
  }
  const ttl = params.ttlSeconds;
  validTtl(ttl);
  return clients.create(params.tools ?? [], config, key, { name: params.name, type: params.type }, tenant, ttl === undefined ? undefined : ttl === null ? null : ttl * 1000, params.mounts,
    made && { definition: made.ref, provision: made.provision, sources: made.sources }, identity);
}

const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
/** Serve the console's static build; unknown paths get index.html for client-side routing. */
async function serveConsole(c: Context) {
  const relative = normalize(decodeURIComponent(new URL(c.req.url).pathname.slice("/console/".length))).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = join(consoleDir, relative);
  let asset = !!relative && !relative.endsWith("/") && file.startsWith(consoleDir + sep);
  let body: Buffer | undefined;
  if (asset) {
    try { body = await readFile(file); } catch { asset = false; }
  }
  // Anything that is not a built file is a client-side route: serve the app shell.
  if (!body) {
    try { body = await readFile(join(consoleDir, "index.html")); }
    catch { return c.body("The console is not built on this host", 404, { "Content-Type": "text/plain" }); }
  }
  const type = asset ? CONTENT_TYPES[extname(file)] ?? "application/octet-stream" : CONTENT_TYPES[".html"];
  return c.body(new Uint8Array(body), 200, {
    "Content-Type": type,
    "Cache-Control": asset && relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
  });
}

/**
 * Where a request goes instead of here: the live owner elsewhere of the actor it
 * addresses, or while this node drains, a live peer for anything it does not hold.
 * Agents are `/clients/<id>`, `/v1/agents/<id>`, `/registry/<id>` or
 * `/internal/agents/<id>`; volumes are `/v1/volumes/<id>` or `/internal/volumes/<id>`.
 */
async function route(url = ""): Promise<{ node: string; actor?: string } | undefined> {
  const agent = /^\/(?:clients|v1\/agents|registry|internal\/agents)\/(client_[a-f0-9]{40})(?:[/?]|$)/.exec(url)?.[1];
  const volume = agent ? undefined : /^\/(?:v1\/volumes|internal\/volumes)\/(vol_[a-f0-9]{24})(?:[/?]|$)/.exec(url)?.[1];
  const actor = agent ?? volume;
  if (actor) {
    const owner = await (agent ? clients.ownerElsewhere(agent) : volumes.ownerElsewhere(actor));
    return owner ? { node: owner, actor } : undefined;
  }
  const peer = ownership.draining ? await ownership.peer() : undefined;
  return peer ? { node: peer } : undefined;
}

/** Node-to-node requests are signed with the session secret all nodes share. */
const internalSignature = (timestamp: string, path: string, body: string) =>
  createHmac("sha256", sessionSecret!).update(`internal:${timestamp}:${path}:${createHash("sha256").update(body).digest("hex")}`).digest("hex");

function signedPost(owner: string, path: string, payload: unknown, timeoutMs = 15_000) {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  return fetch(new URL(path, owner), {
    method: "POST", body, signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", "x-agent-runtime-internal": `${timestamp}.${internalSignature(timestamp, path, body)}` },
  });
}

/** Read a node-to-node request's body, or undefined when its signature is missing, stale or wrong. */
async function signedBody(c: Context): Promise<string | undefined> {
  const body = await readText(c.req.raw.body, 1_100_000);
  const [timestamp, signature] = (c.req.header("x-agent-runtime-internal") ?? "").split(".");
  const expected = Buffer.from(internalSignature(timestamp ?? "", c.req.path, body));
  const given = Buffer.from(signature ?? "");
  if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 60_000 || expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  return body;
}

/** Submit a request to an agent wherever it is served: here, or on the node that owns it. */
async function submitAnywhere(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }) {
  const owner = await clients.ownerElsewhere(agent);
  if (!owner) return clients.submit(agent, tenant, request);
  const response = await signedPost(owner, `/internal/agents/${agent}/requests`, { tenant, request }).catch(error => { ownership.forget(agent); throw error; });
  if (!response.ok) {
    ownership.forget(agent);
    throw Object.assign(new Error(`Owner rejected the request: HTTP ${response.status}`), { status: response.status });
  }
  return response.json();
}

const volumes = new VolumeService({
  db, storage, ownership, idleMs,
  // Volume operations on another node keep their status (and a conflict's current version).
  peer: async (owner, path, payload) => {
    const response = await signedPost(owner, path, payload, 30_000);
    const value = await response.json().catch(() => ({})) as any;
    if (response.ok) return value;
    throw Object.assign(new HttpError(response.status, value.error ?? `Volume owner answered HTTP ${response.status}`), value.current !== undefined ? { current: value.current } : {});
  },
  deliver: submitAnywhere,
});

const FORWARDED = "x-agent-runtime-forwarded";

/** Stream a request to the node that owns its actor, and stream the answer back (SSE included). */
function forward(req: IncomingMessage, res: ServerResponse, owner: string, actor?: string) {
  const target = new URL(req.url ?? "/", owner);
  const upstream = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host, [FORWARDED]: node } }, answer => {
    // The node no longer serves the actor (it moved, or the node is draining): look it up afresh next time.
    if (answer.statusCode === 503) ownership.forget(actor);
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
    // Piping does not end the client's response when the owner dies mid-stream; cut it so the client reconnects now.
    answer.on("close", () => { if (!answer.complete) res.destroy(); });
  });
  upstream.on("error", () => {
    ownership.forget(actor);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }).end('{"error":"The node serving this agent is unreachable; retry"}'); else res.destroy();
  });
  // An owner that cannot be reached (a partitioned or firewalled address) fails fast instead of hanging until the client gives up.
  upstream.on("socket", socket => {
    if (!socket.connecting) return;
    const timer = setTimeout(() => upstream.destroy(new Error("Connecting to the owner timed out")), 5_000);
    socket.once("connect", () => clearTimeout(timer)).once("close", () => clearTimeout(timer));
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

const clients = new ClientSessions(supervisor, {
  secret: sessionSecret, toolTimeoutMs, idleMs, maxAgentsPerTenant, agentLimitFor: async tenant => {
    // An admin's limit for the tenant, else, on free credit, the free limit (never above the default).
    const free = tenants.maxAgents(tenant) === undefined ? await accounts.billing.agentLimit(tenant) : undefined;
    return tenants.maxAgents(tenant) ?? (free === undefined ? undefined : Math.min(free, maxAgentsPerTenant));
  },
  apiKeyFor: async (tenant, provider) => {
    const resolved = await accounts.providerKey(tenant, provider);
    return resolved && { key: resolved.key, platform: resolved.source !== "tenant" };
  },
  onUsage: (tenant, agent, message) => accounts.recordUsage(tenant, agent, message),
  onActive: (tenant, agent, ms) => accounts.recordActive(tenant, agent, ms),
  spendLimit: tenant => accounts.runLimit(tenant),
  rerankers,
  creditLimit: tenant => accounts.billing.creditLimit(tenant),
  db, storage, prefix: "client-sessions/", ownership, volumes,
  get scheduler() { return scheduler; },
  get hooks() { return channels.hooks; },
  definitionFor: async (tenant, id) => {
    const { revision, spec } = await definitions.read(tenant, id);
    const config = sessionConfig({ model: spec.model, systemPrompt: spec.systemPrompt, thinkingLevel: spec.thinkingLevel }, model, process.env.AGENT_SYSTEM_PROMPT, allowedBaseUrls);
    return { id, revision, config: { model: config.model, systemPrompt: config.systemPrompt, thinkingLevel: config.thinkingLevel ?? "off" }, sources: sources(spec) };
  },
  sources: toolSources,
});
// Wake-ups are delivered as prompts with ids derived from the schedule, so repeats are no-ops.
const scheduler = new Scheduler({
  db, node,
  deliver: async (schedule, requestId) => {
    const request = schedule.code !== undefined ? { method: "execute", params: { code: schedule.code } } : { method: "prompt", params: { text: schedule.text! } };
    await submitAnywhere(schedule.agent, schedule.tenant, { id: requestId, ...request });
  },
});
scheduler.start(Number(process.env.AGENT_SCHEDULER_INTERVAL_MS ?? 5_000));
// Messaging channels: webhooks (or a gateway socket one node holds) in, replies out through a durable queue any node can drain.
const channels = new Channels({
  db, accounts, definitions, node, publicUrl, ownership,
  providers: {
    telegram: telegram({ apiUrl: process.env.AGENT_TELEGRAM_API_URL }),
    slack: slack({ apiUrl: process.env.AGENT_SLACK_API_URL }),
    discord: discord({ apiUrl: process.env.AGENT_DISCORD_API_URL }),
  },
  createAgent: (tenant, params, key) => createAgent(tenant, params, key) as Promise<{ id: string }>,
  agentId: (tenant, key) => clients.agentId(tenant, key),
  live: (agent, tenant) => clients.owns(agent, tenant),
  submit: (agent, tenant, request) => submitAnywhere(agent, tenant, request),
  ...(process.env.AGENT_CHANNEL_RETRY_MS ? { retryBaseMs: Number(process.env.AGENT_CHANNEL_RETRY_MS) } : {}),
});
channels.start(Number(process.env.AGENT_SCHEDULER_INTERVAL_MS ?? 5_000));

type Env = { Bindings: HttpBindings; Variables: { tenant: string } };
const app = new Hono<Env>();
// The load balancer's health check: failing it while draining stops new requests arriving here. A retiring
// node stays healthy (ECS replaces tasks that fail it, protected or not) and hands new work to its peers instead.
// The runtime's public signing keys: tool servers verify its identity tokens with them.
app.get("/.well-known/jwks.json", async c => c.json(await signer.jwks(), 200, { "Cache-Control": "public, max-age=300" }));
app.get("/healthz", c => draining ? c.json({ ok: false, draining: true }, 503) : c.json({ ok: true, ...(retiringSince !== undefined ? { retiring: true } : {}) }));
// Every 503 is worth retrying (capacity, an actor moving, this node draining), and so is a 429 (a
// tenant at its agent quota, or an agent with too many queued requests) once work finishes; say when.
app.use(async (c, next) => {
  await next();
  if (c.res.status === 503 && !c.res.headers.has("retry-after")) c.res.headers.set("Retry-After", "1");
  if (c.res.status === 429 && !c.res.headers.has("retry-after")) c.res.headers.set("Retry-After", "5");
});
// One node serves each agent and volume; anything addressed to one another node holds goes there.
// Forwarding works on the raw request and response, so bodies and SSE stream through unbuffered.
app.use(async (c, next) => {
  const target = !c.req.header(FORWARDED) ? await route(c.env.incoming.url).catch(() => undefined) : undefined;
  if (!target) return next();
  forward(c.env.incoming, c.env.outgoing, target.node, target.actor);
  return RESPONSE_ALREADY_SENT;
});

app.post("/internal/agents/:id{client_[a-f0-9]{40}}/requests", async c => {
  let body: string | undefined;
  try { body = await signedBody(c); } catch { return c.body(null, 413); }
  if (body === undefined) return c.body(null, 401);
  try {
    const { tenant, request } = JSON.parse(body);
    return c.json(await clients.submit(c.req.param("id"), tenant, request), 202);
  } catch (error) {
    return c.json({ error: errorText(error) }, errorStatus(error, 400) as ContentfulStatusCode);
  }
});
app.post("/internal/volumes/:id{vol_[a-f0-9]{24}}/ops", async c => {
  let body: string | undefined;
  try { body = await signedBody(c); } catch { return c.body(null, 413); }
  if (body === undefined) return c.body(null, 401);
  try {
    const { tenant, op, args } = JSON.parse(body);
    return c.json(await volumes.handle(c.req.param("id"), tenant, op, args));
  } catch (error) {
    return c.json({ error: errorText(error), ...(error instanceof VersionConflict ? { current: error.current } : {}) }, errorStatus(error, 400) as ContentfulStatusCode);
  }
});
app.all("/internal/*", c => c.body(null, 404));
app.route("/", consoleAuth.app);
app.route("/", channels.app);
app.route("/", api({ accounts, clients, consoleAuth, createAgent, scheduler, channels, volumes, definitions, submit: submitAnywhere, verifyKeys: process.env.AGENT_VERIFY_KEYS !== "false",
  billingAdmins: (process.env.AGENT_BILLING_ADMINS ?? "").split(",").map(value => value.trim()).filter(Boolean) }));
app.get("/console", c => c.redirect("/console/", 302));
app.get("/console/*", serveConsole);
app.get("/", c => c.redirect("/console/", 302));
app.route("/", clients.app);

// Everything below is for operator tokens, and never for browsers.
app.use(async (c, next) => {
  const principal = await accounts.authenticate(c.req.header("authorization"));
  if (!principal) return c.body(null, 401);
  if (c.req.header("origin")) return c.body(null, 403);
  c.set("tenant", principal.tenant);
  await next();
});
app.get("/registry", async c => c.json(await clients.list(c.var.tenant)));
const registered = "/registry/:id{client_[a-f0-9]{40}}";
app.get(registered, async c => c.json(await clients.inspect(c.req.param("id"), c.var.tenant)));
// The operator bridge: the client routes accept requests to the operator's own agents without their token.
app.post(`${registered}/requests`, c => clients.app.request(`/clients/${c.req.param("id")}/requests`,
  { method: "POST", headers: c.req.raw.headers, body: c.req.raw.body, duplex: "half" } as RequestInit, { ...c.env, operatorTenant: c.var.tenant }));
for (const path of [registered, `${registered}/requests`]) app.all(path, c => c.body(null, 405));
app.post("/client-sessions", async c => {
  const params = await readJson(c.req.raw.body, 18 * 1024 * 1024, {});
  const result = await createAgent(c.var.tenant, params, c.req.header("idempotency-key"));
  return c.json(result, 201, { "Cache-Control": "no-store" });
});
app.notFound(c => c.body(null, 404));
// Errors keep their own status (429 quota, 409 conflict, 410 revoked, 503 retry...); an unreachable database is 503, and
// anything else is a request the runtime could not accept (invalid configuration or tools): 400.
app.onError((error, c) => c.body(JSON.stringify({ type: "error", error: errorText(error) }) + "\n", errorStatus(error, 400) as ContentfulStatusCode, { "Content-Type": "application/json" }));

const server = createAdaptorServer({ fetch: app.fetch }) as Server;
server.requestTimeout = 30_000;
server.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  // Without AGENT_PUBLIC_URL the issuer is where this node listens: known only now when PORT is 0.
  if (!process.env.AGENT_PUBLIC_URL) signer.issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(JSON.stringify({ type: "listening", address: server.address(), node, tenants: tenants.source, hosting, storage: storageDescriptor.kind, github: github ? (github.open ? "open" : "org") : false, keyStorage: accounts.canStoreKeys, sandbox, toolSearch: rerankers.length ? rerankers.map(stage => stage.kind).join(",") : "keyword", stripe: stripe ? (stripe.live ? "live" : "test") : false }));
});
// A bad tenants file or secret is rejected whole; the tenants loaded before stay in force.
const reloadTenants = (announce: boolean) => tenants.reload().then(
  () => { if (announce) console.log(JSON.stringify({ type: "tenants_reloaded" })); },
  error => console.error(JSON.stringify({ type: "tenants_reload_failed", error: errorText(error) })));
process.on("SIGHUP", () => void reloadTenants(true));
// Tasks on ECS get no SIGHUP: re-read the secret every minute so tenant changes land without a deploy.
const tenantsTimer = tenants.source === "secret" ? setInterval(() => void reloadTenants(false), 60_000) : undefined;
tenantsTimer?.unref();

// Load for autoscaling, as a CloudWatch metric extracted from the log line.
const loadTimer = setInterval(() => console.log(nodeLoadLine({
  hostedAgents: supervisor.agents.size, sessions: clients.sessions.size, volumes: volumes.size, runningTurns: clients.inFlight(), rssBytes: process.memoryUsage.rss(),
}, process.env.AGENT_SERVICE_NAME, { node, retiring: retiringSince !== undefined })), 60_000);
loadTimer.unref();
// Tail rows a dead node left for agents and volumes that are gone since.
const sweepTimer = setInterval(() => void sweepTails(db).catch(error => console.error(JSON.stringify({ type: "tail_sweep_failed", error: errorText(error) }))), 60 * 60_000);
sweepTimer.unref();
// Deleted and expired agents' data, purged by whichever nodes get to it first.
const purgeMs = Number(process.env.AGENT_PURGE_INTERVAL_MS ?? 60_000);
if (!Number.isInteger(purgeMs) || purgeMs < 1000) throw new Error("AGENT_PURGE_INTERVAL_MS must be an integer of at least 1000");
const purgeTimer = setInterval(() => void clients.sweep(), purgeMs);
purgeTimer.unref();
// Storage is charged to prepaid tenants once a UTC day, by whichever node claims the day's job first.
const billingMs = Number(process.env.AGENT_BILLING_INTERVAL_MS ?? 60 * 60_000);
if (!Number.isInteger(billingMs) || billingMs < 1000) throw new Error("AGENT_BILLING_INTERVAL_MS must be an integer of at least 1000");
// The charge reads tracked totals; a full listing of Storage corrects them every AGENT_STORAGE_RECONCILE_DAYS (0: never, but for the first).
const reconcileDays = Number(process.env.AGENT_STORAGE_RECONCILE_DAYS ?? 7);
if (!Number.isInteger(reconcileDays) || reconcileDays < 0) throw new Error("AGENT_STORAGE_RECONCILE_DAYS must be a non-negative integer");
const chargeStorage = () => void accounts.billing.chargeStorage(storage, storageUsage, node, { reconcileDays }).catch(error => console.error(JSON.stringify({ type: "storage_charge_failed", error: errorText(error) })));
const billingTimer = setInterval(chargeStorage, billingMs);
billingTimer.unref();
setTimeout(chargeStorage, Math.min(billingMs, 60_000)).unref();

/**
 * Deploys and scale-in on ECS. While a turn runs the task is protected, so ECS
 * stops idle tasks instead. A task a newer deployment superseded retires: it takes
 * nothing new (its peers do), lets running turns finish for up to
 * AGENT_RETIRE_MAX_MS, gives up each agent and volume once idle, and drops its
 * protection when nothing runs, so ECS stops it and the SIGTERM drain is empty.
 */
const protection = new TaskProtection({ uri: process.env.ECS_AGENT_URI, idleMs: Number(process.env.AGENT_PROTECTION_IDLE_MS ?? 30_000) });
let retiringSince: number | undefined;
let retired = false;
const workTimer = setInterval(() => {
  if (retiringSince !== undefined) {
    void clients.releaseIdle().then(() => volumes.releaseIdle()).catch(error => console.error(JSON.stringify({ type: "retire_release_failed", error: errorText(error) })));
    if (!retired && !clients.inFlight() && !clients.sessions.size && !volumes.size) {
      retired = true;
      console.log(JSON.stringify({ type: "retired", node, ms: Date.now() - retiringSince }));
    }
  }
  const capped = retiringSince !== undefined && Date.now() - retiringSince > retireMaxMs;
  void protection.update(clients.inFlight() > 0 && !capped);
}, 1_000);
workTimer.unref();
const superseded = await supersession().catch(error => { console.error(JSON.stringify({ type: "ecs_service_unavailable", error: errorText(error) })); return undefined; });
const retireTimer = superseded && setInterval(() => void superseded().then(async yes => {
  if (!yes || retiringSince !== undefined) return;
  retiringSince = Date.now();
  console.log(JSON.stringify({ type: "retiring", node, inFlight: clients.inFlight(), agents: clients.sessions.size, volumes: volumes.size }));
  clients.draining = true;
  await ownership.drain();
}).catch(error => console.error(JSON.stringify({ type: "ecs_service_check_failed", error: errorText(error) }))), Number(process.env.AGENT_ECS_POLL_MS ?? 30_000));
if (retireTimer) retireTimer.unref();

/**
 * Leave the cluster without dropping work. ECS deregisters the task from the load
 * balancer, sends SIGTERM, and SIGKILLs after the task's stopTimeout. /healthz fails
 * at once and this node takes no new agents or volumes: requests for ones it does
 * not hold go to a live peer, or get 503 and Retry-After. Turns and runs that began
 * finish, for up to AGENT_DRAIN_TIMEOUT_MS; runs that never began stay queued for
 * the next owner. Then everything is released, and only then are event streams
 * closed, so clients reconnect to the next owner. A second signal stops waiting.
 */
let drainDeadline = 0;
let draining: Promise<void> | undefined;
async function drain(signal: string) {
  const started = Date.now();
  console.log(JSON.stringify({ type: "drain_started", signal, node, inFlight: clients.inFlight(), agents: clients.sessions.size, volumes: volumes.size }));
  scheduler.stop();
  channels.stop();
  clearInterval(tenantsTimer);
  clearInterval(loadTimer);
  clearInterval(sweepTimer);
  clearInterval(purgeTimer);
  clearInterval(billingTimer);
  clearInterval(workTimer);
  if (retireTimer) clearInterval(retireTimer);
  clients.draining = true;
  let failed = false;
  const step = async (name: string, work: () => Promise<unknown>) => {
    try { await work(); }
    catch (error) { failed = true; console.error(JSON.stringify({ type: "drain_step_failed", step: name, error: errorText(error) })); }
  };
  await step("drain", () => ownership.drain());
  while (clients.inFlight() && Date.now() < drainDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  const unfinished = clients.inFlight();
  await step("agents", () => clients.close());
  await step("supervisor", () => supervisor.close());
  await step("volumes", () => volumes.close());
  await step("mcp", () => mcp.close());
  await step("usage", () => accounts.flushUsage());
  await step("storage usage", () => storageUsage.flush());
  await step("heartbeat", () => ownership.close());
  server.close();
  server.closeAllConnections();
  await step("database", () => db.end());
  console.log(JSON.stringify({ type: "drain_finished", node, ms: Date.now() - started, unfinished }));
  if (failed) throw new Error("Drain finished with errors");
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (draining) { drainDeadline = 0; return; }
  drainDeadline = Date.now() + drainMs;
  draining = drain(signal).then(() => process.exit(0), () => process.exit(1));
});
