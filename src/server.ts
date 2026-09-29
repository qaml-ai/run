import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSupervisor, type Hosting } from "./supervisor.ts";
import { configuredModel, defaultModels } from "./model.ts";
import { errorText, IDENTITY_KEY, SCOPE_KEY } from "./protocol.ts";
import { checkScope, KeyScopes } from "./key-scopes.ts";
import { ENDPOINTS_CHANNEL, Subscribers, Webhooks } from "./webhooks.ts";
import { expireIdempotencyKeys } from "./idempotency.ts";
import { loadDocs, loadRegistry } from "./docs.ts";
import { StorageGc } from "./storage-gc.ts";
import { modelHeadersInput, sessionConfig } from "./session-config.ts";
import { ClientSessions, spendInput } from "./client-sessions.ts";
import { openStorage, storageFromEnvironment } from "../shared/storage-config.ts";
import { StorageUsage } from "./storage-usage.ts";
import { postgresTail, sweepTails } from "./log-tail.ts";
import { databaseFromEnvironment, listenFromEnvironment, migrate } from "./db.ts";
import { Ownership } from "./ownership.ts";
import { tenantsFromEnvironment } from "./tenants.ts";
import { Accounts } from "./accounts.ts";
import { BillingAlerts } from "./billing-alerts.ts";
import { BillingMailer, billingMailConfig } from "./billing-mailer.ts";
import { ConsoleAuth } from "./console-auth.ts";
import { OAuth } from "./oauth.ts";
import { hostedMcp } from "./hosted-mcp.ts";
import { api } from "./api.ts";
import { Scheduler } from "./scheduler.ts";
import { Channels } from "./channels.ts";
import { Definitions, sources, validTtl } from "./definitions.ts";
import { ModelProviders } from "./model-providers.ts";
import { providerInfo } from "./catalog.ts";
import { outboundFromEnvironment } from "./outbound.ts";
import { McpConnections } from "./mcp.ts";
import { ToolSources } from "./tool-sources.ts";
import { applicationTools } from "./mcp-results.ts";
import { telegram } from "./channels-telegram.ts";
import { slack } from "./channels-slack.ts";
import { discord } from "./channels-discord.ts";
import { github as githubChannel } from "./channels-github.ts";
import { webhook } from "./channels-webhook.ts";
import { email, emailReceiver, type EmailOptions } from "./channels-email.ts";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { errorCode, errorStatus, HttpError, readJson, readText } from "./http.ts";
import { VersionConflict, VolumeService } from "./volumes.ts";
import { FILE_LIMITS, FileLinks } from "./files.ts";
import { nodeLoadLine, nodeUrl, supersession, taskAddress, TaskProtection } from "./ecs.ts";
import { webhookBacklogLine } from "./metrics.ts";
import { runtimeSecrets } from "./secrets.ts";
import { checkSandbox } from "./codemode.ts";
import { pricingFromEnvironment } from "./pricing.ts";
import { searchProvidersFromEnvironment, WebSearch } from "./web-search.ts";
import { WebRender } from "./web-render.ts";
import { Stripe } from "./stripe.ts";
import { identityInput, RuntimeSigner } from "./identity.ts";
import { builtinsInput } from "./builtins.ts";
import { rerankersFromEnv } from "./tool-search.ts";
import { Inputs, inputView } from "./inputs.ts";
import { BrowserTokens } from "./browser-tokens.ts";

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
const pricing = pricingFromEnvironment();
const rerankers = rerankersFromEnv(process.env, secrets.toolSearchKey || platformOpenRouter, pricing.openrouterCreditMultiplier);
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
const stripe = secrets.stripe && new Stripe({ ...secrets.stripe, apiUrl: process.env.AGENT_STRIPE_API_URL, portalConfiguration: process.env.AGENT_STRIPE_PORTAL_CONFIGURATION });
const accounts = new Accounts({ tenants, db, secretsKey: secrets.secretsKey, pricing, publicUrl, stripe });
accounts.billing.autoTopup?.start();
const billingAlerts = new BillingAlerts(db, accounts);
const mailConfig = billingMailConfig(process.env, secrets.billingEmailSecret);
if (mailConfig && !accounts.canStoreKeys) throw new Error("Billing email requires AGENT_SECRETS_KEY for confirmation tokens");
const billingMailer = mailConfig ? new BillingMailer({ db, alerts: billingAlerts, ...mailConfig }) : undefined;
billingMailer?.start();
// Keep the production eligibility threshold in deployment configuration, not public defaults.
const minAccountDays = process.env.AGENT_SIGNUP_MIN_ACCOUNT_DAYS === undefined ? undefined : Number(process.env.AGENT_SIGNUP_MIN_ACCOUNT_DAYS);
if (minAccountDays !== undefined && (!Number.isFinite(minAccountDays) || minAccountDays < 0 || !Number.isSafeInteger(Math.round(minAccountDays * 86_400_000)))) {
  throw new Error("AGENT_SIGNUP_MIN_ACCOUNT_DAYS must be a non-negative, safely representable number of days");
}
if (secrets.github && pricing.startingGrant > 0 && minAccountDays === undefined) throw new Error("Configure AGENT_SIGNUP_MIN_ACCOUNT_DAYS before enabling GitHub starting credit");
const github = secrets.github && {
  ...secrets.github, org: process.env.GITHUB_ORG ?? "qaml-ai", open: process.env.AGENT_OPEN_SIGNUP === "true", minAccountDays,
  webUrl: process.env.AGENT_GITHUB_WEB_URL, apiUrl: process.env.AGENT_GITHUB_API_URL,
};
const consoleAuth = new ConsoleAuth({ accounts, secret: sessionSecret, publicUrl, github });
const consoleDir = resolve(process.env.AGENT_CONSOLE_DIR ?? fileURLToPath(new URL("../console/dist", import.meta.url)));

// Every call to a URL a tenant configured (MCP servers, web_fetch) goes through one guard: public addresses only, but for
// origins the operator allows (AGENT_OUTBOUND_ALLOW_ORIGINS), which web_fetch, search and render never reach (`withoutOrigins`).
const outbound = outboundFromEnvironment();
const mcp = new McpConnections({ outbound });
// Identity tokens for tool servers with auth "runtime", verified against /.well-known/jwks.json.
const signer = new RuntimeSigner({ db, accounts, issuer: publicUrl });
// OAuth for the hosted MCP endpoint; the issuer follows the signer's, which is the public URL once it is known.
const oauth = new OAuth({ db, accounts, consoleAuth, secret: sessionSecret, publicUrl: () => signer.issuer, github: !!github });
// web_search and web_fetch's renderer: the tenant's key for each provider, else an admin's, else (prepaid) the
// platform's, whose calls are charged to credit at that provider's price.
const webKey = async (tenant: string, provider: string) => {
  const resolved = await accounts.providerKey(tenant, provider);
  // Only the platform's own key is the platform's: an admin's key for the tenant (its apiKeys) is the tenant's to account for.
  return resolved && { key: resolved.key, platform: resolved.source === "platform" };
};
const searchTimeoutMs = Number(process.env.AGENT_WEB_SEARCH_TIMEOUT_MS ?? 5_000);
if (!Number.isInteger(searchTimeoutMs) || searchTimeoutMs < 100 || searchTimeoutMs > 60_000) throw new Error("AGENT_WEB_SEARCH_TIMEOUT_MS must be an integer between 100 and 60000");
const search = new WebSearch({
  outbound: outbound.withoutOrigins(), ...searchProvidersFromEnvironment(), key: webKey, timeoutMs: searchTimeoutMs,
  price: provider => accounts.billing.pricing.webSearch[provider],
  onSearch: (tenant, agent, usage) => accounts.recordUsage(tenant, agent, usage),
});
const render = new WebRender({
  outbound: outbound.withoutOrigins(), key: webKey, price: accounts.billing.pricing.webRender, endpoint: process.env.AGENT_FIRECRAWL_SCRAPE_URL,
  onRender: (tenant, agent, usage) => accounts.recordUsage(tenant, agent, usage),
});
const toolSources = new ToolSources({ accounts, mcp, outbound, signer, search, render, get scheduler() { return scheduler; }, get volumes() { return volumes; }, get links() { return links; } });
// Tenants' own OpenAI-compatible model providers.
const modelProviders = new ModelProviders({ db, accounts, outbound });
const definitions = new Definitions({ db, accounts, outbound, customProviders: tenant => modelProviders.resolvable(tenant) });
// Saving a definition lists its MCP servers, as its agents would.
definitions.listMcp = (tenant, id, servers) => toolSources.listed(tenant, id, servers);
const keyScopes = new KeyScopes({ db, accounts, outbound });
const defaults = defaultModels(model);
/** The model an agent of `tenant` that names none gets: the first default its key scope or tenant has a key for, else the first. */
async function defaultModelFor(tenant: string, keyScope?: string) {
  const keyed = await accounts.keyedProviders(tenant);
  for (const candidate of defaults) if (keyed(candidate.provider) || (keyScope && await keyScopes.entry(tenant, keyScope, candidate.provider))) return candidate;
  return defaults[0];
}
modelProviders.onDelete = (tenant, name) => keyScopes.forgetProvider(tenant, name);
// Each model response's usage, POSTed to the tenant's receiver from a durable outbox any node sends from.
// Which tenants have endpoints for run events: runs of the others write none.
const subscribers = new Subscribers(db);
const webhooks = new Webhooks({ db, accounts, outbound, subscribers, ...(process.env.AGENT_USAGE_WEBHOOK_RETRY_MS ? { retryBaseMs: Number(process.env.AGENT_USAGE_WEBHOOK_RETRY_MS) } : {}) });
webhooks.start(Number(process.env.AGENT_SCHEDULER_INTERVAL_MS ?? 5_000));
// Idempotency keys' answers are kept a day.
setInterval(() => void expireIdempotencyKeys(db).catch(error => console.error(JSON.stringify({ type: "idempotency_expiry_failed", error: errorText(error) }))), 60 * 60_000).unref();

/** Provision an agent for `tenant` (POST /v1/agents). */
async function createAgent(tenant: string, params: any, key?: string) {
  // The application's tools are its attached MCP server's: the tools/list it declares.
  const { mcp: _mcp, subject: _subject, context: _context, keyScope, spendLimit: limit, modelHeaders: headers, builtins: asked, ...rest } = params ?? {};
  // The application's tools as it declared them, whose hash its connections are told (`toolsHash`).
  const mcpTools = params?.mcp?.tools;
  // Who the agent acts for, and context for its tool servers' identity tokens.
  const identity = identityInput(params ?? {});
  if (keyScope !== undefined) checkScope(keyScope);
  // An agent's own built-in tools; one made from a definition has its definition's.
  if (asked !== undefined && params.definition !== undefined) throw new HttpError(400, "builtins come from the definition; change them there");
  const builtins = asked === undefined ? undefined : builtinsInput(asked);
  const spendLimit = limit === undefined ? undefined : spendInput(limit) ?? undefined;
  const modelHeaders = headers === undefined ? null : modelHeadersInput(headers);
  try { params = { ...rest, tools: applicationTools(params ?? {}) }; } catch (error) { throw new HttpError(400, errorText(error)); }
  const made = params?.definition !== undefined ? await definitions.provision(tenant, params) : undefined;
  if (made) params = made.params;
  const custom = await modelProviders.resolvable(tenant, keyScope);
  const fallback = params.model === undefined ? await defaultModelFor(tenant, keyScope) : model;
  const config = { ...sessionConfig(params, fallback, process.env.AGENT_SYSTEM_PROMPT, allowedBaseUrls, tenants.modelEndpoints(tenant), custom), ...(modelHeaders ? { modelHeaders } : {}) };
  // A custom provider's models need no key of the tenant's: the provider has its own, or takes none.
  if (!Object.hasOwn(custom ?? {}, config.model.provider) && !(keyScope && await keyScopes.entry(tenant, keyScope, config.model.provider)) && !await accounts.hasKey(tenant, config.model.provider)) {
    // Said plainly when the model is the runtime's default: the caller may not know one was chosen for it.
    const which = `${config.model.provider}/${config.model.id}${params.model === undefined ? ", the runtime's default model (this agent names none)" : ""}`;
    throw new Error(`No ${config.model.provider} API key is configured for tenant ${tenant}, for ${which}; name a model you can use (GET /v1/models?available=true), or set a key with PUT /v1/providers/${config.model.provider}/key`);
  }
  const ttl = params.ttlSeconds;
  validTtl(ttl);
  // An agent made with a key is one the application comes back to: it lives until deleted, unless it says otherwise.
  // One made without is a scratch agent nothing can find again once its id is lost: it lives a day, unless it says.
  const lifetime = ttl === undefined ? (key !== undefined ? null : undefined) : ttl === null ? null : ttl * 1000;
  const { reconfigure, ...made_ } = await clients.create(params.tools ?? [], config, key, { name: params.name, type: params.type }, tenant, lifetime, params.mounts,
    made && { definition: made.ref, provision: made.provision, overrides: made.overrides, sources: made.sources }, identity,
    { keyScope, spendLimit, builtins, ...(mcpTools !== undefined ? { toolsHash: createHash("sha256").update(JSON.stringify(mcpTools)).digest("hex") } : {}) });
  if (!reconfigure) return made_;
  // The key's agent exists: bring it to this configuration between its turns. Every upsert queues its own request, so
  // the last one sent wins; one whose configuration the agent has already changes nothing when it runs.
  const reconfigured = await submitAnywhere(made_.id, tenant, { id: `upsert-${randomUUID()}`, method: "configure", params: reconfigure as Record<string, unknown> });
  return { ...made_, reconfigured };
}

const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
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

// Signed file links, under a key derived from the session secret, so every node verifies any node's links.
const links = new FileLinks(sessionSecret, publicUrl);
// Where browsers reach the runtime, as browser tokens say: AGENT_PUBLIC_URL unless set; empty for none (a private runtime
// whose browsers read through the application's proxy).
const browserUrl = process.env.AGENT_BROWSER_URL?.replace(/\/+$/, "");

const FORWARDED = "x-agent-runtime-forwarded";

/** Stream a request to the node that owns its actor, and stream the answer back (SSE included). */
function forward(req: IncomingMessage, res: ServerResponse, owner: string, actor?: string) {
  const target = new URL(req.url ?? "/", owner);
  const via = req.headers[FORWARDED];
  const upstream = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host, [FORWARDED]: typeof via === "string" ? `${via},${node}` : node } }, answer => {
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

// Human input waits in Postgres; a tool's opaque request state is sealed when the runtime can seal.
const inputs = new Inputs({ db, ...(accounts.canStoreKeys ? { sealer: accounts } : {}) });
const clients = new ClientSessions(supervisor, {
  runEvents: tenant => subscribers.runs(tenant),
  secret: sessionSecret, toolTimeoutMs, idleMs, maxAgentsPerTenant, ...(process.env.AGENT_SNAPSHOT_BYTES ? { snapshotBytes: Number(process.env.AGENT_SNAPSHOT_BYTES) } : {}), orphanSweepMs: Number(process.env.AGENT_ORPHAN_SWEEP_MS ?? 30_000), watcherLimitFor: tenant => tenants.maxWatchers(tenant), agentLimitFor: async tenant => {
    // An admin's limit for the tenant, else, on free credit, the free limit (never above the default).
    const free = tenants.maxAgents(tenant) === undefined ? await accounts.billing.agentLimit(tenant) : undefined;
    return tenants.maxAgents(tenant) ?? (free === undefined ? undefined : Math.min(free, maxAgentsPerTenant));
  },
  apiKeyFor: async (tenant, provider, keyScope) => {
    // A tenant's own endpoint gets identity tokens, and its calls cost the runtime nothing.
    if (Object.hasOwn(tenants.modelEndpoints(tenant) ?? {}, provider)) return { key: IDENTITY_KEY, platform: false };
    // An agent with a key scope, or on the tenant's own provider, resolves its key at each call, so a changed key applies at once.
    if (keyScope || await modelProviders.has(tenant, provider)) return { key: SCOPE_KEY, platform: false };
    const resolved = await accounts.providerKey(tenant, provider);
    return resolved && { key: resolved.key, platform: resolved.source !== "tenant" };
  },
  scopedKey: async (tenant, keyScope, provider) => {
    const entry = keyScope ? await keyScopes.entry(tenant, keyScope, provider) : undefined;
    // The key scope's or the tenant's own provider: the scope's key or address where it gives one, else the provider's; never the platform's.
    const own = await modelProviders.credentials(tenant, provider, keyScope);
    if (own) return { ...own, ...entry, baseUrl: entry?.baseUrl ?? own.baseUrl, apiKey: entry?.apiKey ?? own.apiKey ?? "", platform: false };
    // A scope's entry for a provider that is neither built in nor the tenant's any more (deleted) is nothing to call.
    if (entry && !providerInfo(provider)) return undefined;
    if (entry) return { ...entry, apiKey: entry.apiKey ?? "", platform: false };
    const resolved = await accounts.providerKey(tenant, provider);
    return resolved && { apiKey: resolved.key, platform: resolved.source !== "tenant" };
  },
  modelEndpoints: tenant => tenants.modelEndpoints(tenant),
  customProviders: (tenant, keyScope) => modelProviders.resolvable(tenant, keyScope),
  modelToken: (audience, claims) => signer.token(audience, claims),
  onUsage: (tenant, agent, message) => accounts.recordUsage(tenant, agent, message),
  onActive: (tenant, agent, ms) => accounts.recordActive(tenant, agent, ms),
  spendLimit: tenant => accounts.runLimit(tenant),
  rerankers,
  creditLimit: tenant => accounts.billing.creditLimit(tenant),
  db, storage, prefix: "client-sessions/", ownership, volumes, links,
  get scheduler() { return scheduler; },
  get hooks() { return channels.hooks; },
  definitionFor: async (tenant, id) => {
    const { revision, spec } = await definitions.read(tenant, id);
    const config = sessionConfig({ model: spec.model, systemPrompt: spec.systemPrompt, thinkingLevel: spec.thinkingLevel }, spec.model === undefined ? await defaultModelFor(tenant) : model, process.env.AGENT_SYSTEM_PROMPT, allowedBaseUrls, tenants.modelEndpoints(tenant), await modelProviders.resolvable(tenant));
    return { id, revision, config: { model: config.model, systemPrompt: config.systemPrompt, thinkingLevel: config.thinkingLevel ?? "off", fileTools: spec.fileTools !== false }, sources: sources(spec) };
  },
  sources: toolSources,
  inputs,
  submit: (agent, tenant, request) => submitAnywhere(agent, tenant, request),
});
// An agent loaded on another node: this node's idle watchers of it end, and reconnect to that node.
// A tenant's webhook endpoints changed on some node: read them again at its next run.
const loads = await listenFromEnvironment({
  agent_runtime_loaded: payload => {
    const [from, agent] = payload.split(" ");
    if (from !== node && agent) clients.loadedElsewhere(agent);
  },
  [ENDPOINTS_CHANNEL]: tenant => subscribers.forget(tenant),
});
// Wake-ups are delivered as prompts with ids derived from the schedule, so repeats are no-ops.
const scheduler = new Scheduler({
  db, node,
  deliver: async (schedule, requestId) => {
    // Schedules run unattended: without the application, its tools' calls fail as not connected.
    const request = schedule.code !== undefined ? { method: "execute", params: { code: schedule.code, allowDisconnected: true } } : { method: "prompt", params: { text: schedule.text!, allowDisconnected: true } };
    await submitAnywhere(schedule.agent, schedule.tenant, { id: requestId, ...request });
  },
  also: now => clients.expireInputs(now),
});
scheduler.start(Number(process.env.AGENT_SCHEDULER_INTERVAL_MS ?? 5_000));
// Email channels, when the runtime has a domain SES receives for: mail arrives through SNS at one shared route.
const emailOptions: EmailOptions | undefined = process.env.AGENT_EMAIL_DOMAIN ? {
  db, domain: process.env.AGENT_EMAIL_DOMAIN, topics: (process.env.AGENT_EMAIL_SNS_TOPICS ?? "").split(",").map(topic => topic.trim()).filter(Boolean),
  ...(process.env.AGENT_EMAIL_BUCKET ? { bucket: process.env.AGENT_EMAIL_BUCKET } : {}), region: process.env.AGENT_EMAIL_REGION ?? process.env.AWS_REGION,
} : undefined;
// Messaging channels: webhooks (or a gateway socket one node holds) in, replies out through a durable queue any node can drain.
const channels = new Channels({
  db, accounts, definitions, node, publicUrl, ownership,
  providers: {
    telegram: telegram({ apiUrl: process.env.AGENT_TELEGRAM_API_URL }),
    slack: slack({ apiUrl: process.env.AGENT_SLACK_API_URL }),
    discord: discord({ apiUrl: process.env.AGENT_DISCORD_API_URL }),
    github: githubChannel({ apiUrl: process.env.AGENT_GITHUB_API_URL }),
    webhook: webhook({ outbound }),
    ...(emailOptions ? { email: email(emailOptions) } : {}),
  },
  createAgent: (tenant, params, key) => createAgent(tenant, params, key) as Promise<{ id: string }>,
  agentId: (tenant, key) => clients.agentId(tenant, key),
  live: (agent, tenant) => clients.owns(agent, tenant),
  submit: (agent, tenant, request) => submitAnywhere(agent, tenant, request),
  files: {
    upload: (agent, tenant, requestId, name, source, contentType) => clients.uploadFor(agent, tenant, requestId, name, source, contentType),
    ref: (agent, tenant, path) => clients.fileFor(agent, tenant, path),
    read: (tenant, ref) => volumes.stream(tenant, ref),
    link: async (agent, tenant, path) => (await clients.linkFor(agent, tenant, path, FILE_LIMITS.maxLinkSeconds)).url,
  },
  inputs: {
    pending: async agent => (await inputs.pending(agent)).map(inputView),
    answer: (agent, tenant, input, answer) => clients.answer(agent, tenant, [{ id: input, body: answer }], "channel"),
  },
  ...(process.env.AGENT_CHANNEL_RETRY_MS ? { retryBaseMs: Number(process.env.AGENT_CHANNEL_RETRY_MS) } : {}),
});
channels.start(Number(process.env.AGENT_SCHEDULER_INTERVAL_MS ?? 5_000));

type Env = { Bindings: HttpBindings; Variables: { tenant: string } };
const app = new Hono<Env>();
// The load balancer's health check: failing it while draining stops new requests arriving here. A retiring
// node stays healthy (ECS replaces tasks that fail it, protected or not) and hands new work to its peers instead.
// The runtime's public signing keys: tool servers verify its identity tokens with them.
app.get("/.well-known/jwks.json", async c => c.json(await signer.jwks(), 200, { "Cache-Control": "public, max-age=300" }));
// OAuth authorization server metadata (RFC 8414), as MCP's authorization spec reads it. It serves two purposes: the
// issuer of identity tokens and where its keys are, so a tool server that names the runtime in its protected-resource
// metadata can verify them with standard OAuth tooling; and the endpoints MCP clients of the hosted /mcp sign in
// with (src/oauth.ts), whose access tokens are opaque and never signed with those keys.
app.get("/.well-known/oauth-authorization-server", c => c.json({
  issuer: signer.issuer, jwks_uri: `${signer.issuer}/.well-known/jwks.json`, ...oauth.metadata(),
}, 200, { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" }));
// The public docs (docs/ in the image), for people and for models: cacheable, and readable from any page.
const docs = loadDocs(resolve(process.env.AGENT_DOCS_DIR ?? fileURLToPath(new URL("../docs", import.meta.url))), publicUrl);
// The UI registry's JSON (packages/registry/public/r/ in the image), for `npx shadcn add <runtime>/r/<name>.json`.
const registry = loadRegistry(resolve(process.env.AGENT_REGISTRY_DIR ?? fileURLToPath(new URL("../packages/registry/public/r", import.meta.url))), publicUrl);
// Matched on the request's path as sent, before any decoding or dot-segment folding: only exact document paths answer.
app.use(async (c, next) => {
  const path = (c.env.incoming.url ?? "").split("?")[0];
  const served = path === "/llms.txt" || path === "/llms-full.txt" || path === "/docs" || path.startsWith("/docs/") ? docs : path === "/r" || path.startsWith("/r/") ? registry : undefined;
  if (!served) return next();
  const doc = c.req.method === "GET" || c.req.method === "HEAD" ? served.get(path) : undefined;
  if (!doc) return c.json({ type: "error", error: "Unknown document", code: "NOT_FOUND" }, 404, { "Access-Control-Allow-Origin": "*" });
  return c.body(doc.body, 200, { "Content-Type": doc.type, "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" });
});
app.get("/healthz", c => draining ? c.json({ ok: false, draining: true }, 503) : c.json({ ok: true, ...(retiringSince !== undefined ? { retiring: true } : {}) }));
// Every 503 is worth retrying (capacity, an actor moving, this node draining), and so is a 429 (a
// tenant at its agent quota, or an agent with too many queued requests) once work finishes; say when.
app.use(async (c, next) => {
  await next();
  if (c.res.status === 503 && !c.res.headers.has("retry-after")) c.res.headers.set("Retry-After", "1");
  if (c.res.status === 429 && !c.res.headers.has("retry-after")) c.res.headers.set("Retry-After", "5");
});
// A browser token's reads, from any origin: the token is what grants them, as with publishable or ephemeral keys.
// Any node answers the preflight, and the node that serves the read marks it readable (errors too, so the browser
// sees a 401 and mints a new token). No credentials are allowed, every other route gets no CORS headers, and
// neither does any request made with the tenant's own tokens.
const BROWSER_READS = /^\/v1\/agents\/client_[a-f0-9]{40}\/(?:events|state|history|inputs)$/;
app.use(async (c, next) => {
  if (!c.req.header("origin") || !BROWSER_READS.test(c.req.path)) return next();
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "Authorization, Last-Event-ID, Accept", "Access-Control-Max-Age": "86400" });
  }
  if (BrowserTokens.carries(c.req.header("authorization"))) c.env.outgoing.setHeader("Access-Control-Allow-Origin", "*");
  return next();
});
// One node serves each agent and volume; anything addressed to one another node holds goes there.
// Forwarding works on the raw request and response, so bodies and SSE stream through unbuffered.
// A forwarded request goes no further, but for one that reached a draining node: its sender's cached owner can
// trail a release by a few seconds, so it goes on once more (to the live owner, or a peer that takes it) instead of a 503.
app.use(async (c, next) => {
  const via = c.req.header(FORWARDED);
  const target = !via || (ownership.draining && !via.includes(",")) ? await route(c.env.incoming.url).catch(() => undefined) : undefined;
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
app.route("/", oauth.app);
// The hosted MCP endpoint: its tools call this node's REST API locally, as the caller.
const loopbackHost = !process.env.HOST || ["0.0.0.0", "::", "127.0.0.1", "localhost"].includes(process.env.HOST) ? "127.0.0.1" : process.env.HOST.includes(":") ? `[${process.env.HOST}]` : process.env.HOST;
app.route("/", hostedMcp({
  authenticate: async authorization => await accounts.authenticate(authorization) ?? await oauth.authenticate(authorization),
  publicUrl: () => signer.issuer,
  loopback: () => `http://${loopbackHost}:${(server.address() as { port: number }).port}`,
}));
// Before channels.app, whose /channels/:type/:id would take /channels/email/inbound.
if (emailOptions) app.route("/", emailReceiver(channels, emailOptions));
app.route("/", channels.app);
// Browser tokens: HMACs under a key derived from the session secret, so any node checks any node's.
const browserTokens = new BrowserTokens(sessionSecret);
if (billingMailer) app.route("/", billingMailer.feedback());
app.route("/", api({ accounts, billingAlerts: { service: billingAlerts, emailEnabled: !!billingMailer }, clients, consoleAuth, oauth, createAgent, modelProviders, defaultModel: async tenant => { const chosen = await defaultModelFor(tenant); return `${chosen.provider}/${chosen.id}`; }, keyScopes, webhooks, scheduler, ...(process.env.AGENT_IDEMPOTENCY_LOCK_MS ? { idempotencyLockMs: Number(process.env.AGENT_IDEMPOTENCY_LOCK_MS) } : {}), channels, volumes, definitions, links, browserTokens, get browserUrl() { return browserUrl === undefined ? links.publicUrl : browserUrl || undefined; }, submit: submitAnywhere, verifyKeys: process.env.AGENT_VERIFY_KEYS !== "false",
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
app.notFound(c => c.body(null, 404));
// Errors keep their own status (429 quota, 409 conflict, 410 revoked, 503 retry...); an unreachable database is 503, and
// anything else is a request the runtime could not accept (invalid configuration or tools): 400.
app.onError((error, c) => {
  const status = errorStatus(error, 400);
  return c.body(JSON.stringify({ type: "error", error: errorText(error), code: errorCode(error, status) }) + "\n", status as ContentfulStatusCode, { "Content-Type": "application/json" });
});

const server = createAdaptorServer({ fetch: app.fetch }) as Server;
// A request has 30 s to arrive whole, except an upload, which streams to storage a chunk at a time
// and may take FILE_LIMITS.uploadMs. Node's requestTimeout is one value for every request, so it is off.
server.requestTimeout = 0;
const UPLOAD = /^\/(?:v1\/volumes\/vol_[a-f0-9]{24}\/files\/|v1\/links\/|v1\/agents\/client_[a-f0-9]{40}\/uploads\/|clients\/client_[a-f0-9]{40}\/(?:files|uploads)\/)/;
server.on("request", (req: IncomingMessage) => {
  const timer = setTimeout(() => { if (!req.complete) req.socket.destroy(); }, req.method === "PUT" && UPLOAD.test(req.url ?? "") ? FILE_LIMITS.uploadMs : 30_000);
  timer.unref();
  req.once("close", () => clearTimeout(timer));
});
server.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  // Without AGENT_PUBLIC_URL the issuer is where this node listens: known only now when PORT is 0.
  if (!process.env.AGENT_PUBLIC_URL) signer.issuer = links.publicUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
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
const loadTimer = setInterval(() => {
  const memory = process.memoryUsage();
  console.log(nodeLoadLine({
    hostedAgents: supervisor.agents.size, sessions: clients.sessions.size, volumes: volumes.size, runningTurns: clients.inFlight(), rssBytes: memory.rss,
    watchers: clients.watchers, dbConnections: db.totalCount, dbIdle: db.idleCount, dbWaiting: db.waitingCount,
    heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers,
  }, process.env.AGENT_SERVICE_NAME, { node, retiring: retiringSince !== undefined }));
  // Every node reports the shared outboxes' backlog: read it with Maximum.
  void webhooks.backlog().then(backlog => console.log(webhookBacklogLine(backlog)))
    .catch(error => console.error(JSON.stringify({ type: "webhook_backlog_failed", error: errorText(error) })));
}, 60_000);
loadTimer.unref();
// Tail rows a dead node left for agents and volumes that are gone since.
const sweepTimer = setInterval(() => void sweepTails(db).catch(error => console.error(JSON.stringify({ type: "tail_sweep_failed", error: errorText(error) }))), 60 * 60_000);
sweepTimer.unref();
// Deleted and expired agents' data, purged by whichever nodes get to it first.
const purgeMs = Number(process.env.AGENT_PURGE_INTERVAL_MS ?? 60_000);
if (!Number.isInteger(purgeMs) || purgeMs < 1000) throw new Error("AGENT_PURGE_INTERVAL_MS must be an integer of at least 1000");
const purgeTimer = setInterval(() => void clients.sweep(), purgeMs);
purgeTimer.unref();
// Chunks nothing refers to any more, and deleted volumes' objects, collected a tenant at a time by whichever node is free.
// Off unless AGENT_GC_ENABLED; with AGENT_GC_DRY_RUN it only logs what it would delete. What it needs (pins, which chunks
// writes created) is recorded either way, so turning it on later loses nothing.
const storageGc = new StorageGc({ db, storage, volumes, graceMs: Number(process.env.AGENT_GC_GRACE_MS ?? 24 * 60 * 60_000), intervalMs: Number(process.env.AGENT_GC_INTERVAL_MS ?? 6 * 60 * 60_000), dryRun: process.env.AGENT_GC_DRY_RUN === "true" });
if (process.env.AGENT_GC_ENABLED === "true") storageGc.start(Number(process.env.AGENT_GC_POLL_MS ?? 60_000));
// Agents no node holds with work left (a dead owner's turn, runs a drain queued) are loaded by whichever node gets to them first,
// so their runs resume even when no one reads them.
const orphanMs = Number(process.env.AGENT_ORPHAN_SWEEP_MS ?? 30_000);
if (!Number.isInteger(orphanMs) || orphanMs < 0) throw new Error("AGENT_ORPHAN_SWEEP_MS must be a non-negative integer (0: no sweep)");
const orphanTimer = orphanMs ? setInterval(() => void clients.resumeOrphans().catch(error => console.error(JSON.stringify({ type: "orphan_sweep_failed", error: errorText(error) }))), orphanMs) : undefined;
orphanTimer?.unref();
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
 * stops idle tasks instead. A task a newer deployment superseded retires once that
 * deployment runs all its tasks (or AGENT_RETIRE_WAIT_MS has passed) and a peer
 * that is not retiring has joined: it takes nothing new (its peers do), lets running
 * turns finish for up to AGENT_RETIRE_MAX_MS, gives up each agent and volume once
 * idle, and drops its protection when nothing runs, so ECS stops it and the SIGTERM
 * drain is empty. A retiring task left with no such peer serves again until one joins:
 * refusing work would leave it nowhere to go.
 */
const protection = new TaskProtection({ uri: process.env.ECS_AGENT_URI, idleMs: Number(process.env.AGENT_PROTECTION_IDLE_MS ?? 30_000) });
let retiringSince: number | undefined;
let retired = false;
let pausing = false;
const workTimer = setInterval(() => {
  if (retiringSince !== undefined) {
    void clients.releaseIdle().then(() => volumes.releaseIdle()).catch(error => console.error(JSON.stringify({ type: "retire_release_failed", error: errorText(error) })));
    if (!retired && !clients.inFlight() && !clients.sessions.size && !volumes.size) {
      retired = true;
      console.log(JSON.stringify({ type: "retired", node, ms: Date.now() - retiringSince }));
    }
    if (!pausing) {
      pausing = true;
      void ownership.peer().then(async peer => {
        if (peer || retiringSince === undefined || draining) return;
        console.log(JSON.stringify({ type: "retire_paused", node, ms: Date.now() - retiringSince }));
        retiringSince = undefined;
        retired = false;
        clients.draining = false;
        await ownership.undrain();
      }).catch(error => console.error(JSON.stringify({ type: "retire_pause_failed", error: errorText(error) }))).finally(() => { pausing = false; });
    }
  }
  const capped = retiringSince !== undefined && Date.now() - retiringSince > retireMaxMs;
  void protection.update(clients.inFlight() > 0 && !capped);
}, 1_000);
workTimer.unref();
const superseded = await supersession().catch(error => { console.error(JSON.stringify({ type: "ecs_service_unavailable", error: errorText(error) })); return undefined; });
const retireTimer = superseded && setInterval(() => void superseded().then(async state => {
  if (state !== "superseded" || retiringSince !== undefined || draining || !await ownership.peer()) return;
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
  webhooks.stop();
  storageGc.stop();
  clearInterval(tenantsTimer);
  clearInterval(loadTimer);
  clearInterval(sweepTimer);
  clearInterval(purgeTimer);
  clearInterval(orphanTimer);
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
  await step("auto top-up", async () => { await accounts.billing.autoTopup?.stop(); });
  await step("billing email", async () => { await billingMailer?.stop(); });
  await step("storage usage", () => storageUsage.flush());
  await step("listen", () => loads.close());
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
