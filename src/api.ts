import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Accounts, Principal } from "./accounts.ts";
import { answerList, type ClientSessions } from "./client-sessions.ts";
import type { ConsoleAuth } from "./console-auth.ts";
import { listModels, listProviders, modelInfo, providerInfo } from "./catalog.ts";
import { resolveModel } from "./session-config.ts";
import { checkProviderKey } from "./key-check.ts";
import { errorText } from "./protocol.ts";
import { scheduleInput, type Scheduler } from "./scheduler.ts";
import { errorStatus, HttpError, readJson, readText } from "./http.ts";
import type { Channels } from "./channels.ts";
import { channelRoutes } from "./channels-api.ts";
import type { Definitions } from "./definitions.ts";
import { definitionRoutes } from "./definitions-api.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import * as schema from "./api-schemas.ts";
import { normalizePath, VOLUME_LIMITS, type VolumeService } from "./volumes.ts";
import { declaredType, fileResponse, type FileLinks } from "./files.ts";

/**
 * Tenant self-service REST API. Every console action goes through these routes,
 * so anything the console can do, a script can do with an API token. The routes
 * below are the OpenAPI document served at /v1/openapi.json.
 */
export interface ApiContext {
  accounts: Accounts;
  clients: ClientSessions;
  consoleAuth: ConsoleAuth;
  /** Provision an agent for a tenant (shared with POST /client-sessions). */
  createAgent(tenant: string, params: any, idempotencyKey?: string): Promise<unknown>;
  verifyKeys?: boolean;
  scheduler?: Scheduler;
  channels?: Channels;
  volumes?: VolumeService;
  definitions?: Definitions;
  /** Tenants whose operator tokens may adjust any tenant's credit (AGENT_BILLING_ADMINS). */
  billingAdmins?: string[];
  /** Signs and verifies file links (`/v1/links`). */
  links?: FileLinks;
  /** Submit a request to an agent on whichever node serves it (applying definitions). */
  submit?: (agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }) => Promise<RequestRecord>;
}
type Env = { Variables: { principal: Principal & { login?: string } } };

const DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "Agent runtime API", version: "1.0.0" },
  security: [{ bearer: [] }, { console: [] }] as Record<string, string[]>[],
};
const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });
const content = (value: z.ZodType) => ({ content: { "application/json": { schema: value } } });
const reply = (description: string, value: z.ZodType) => ({ description, ...content(value) });
const failure = { default: reply("Error", schema.ApiError) };
const agentId = z.object({ id: z.string() });
const binary = (description: string) => ({ description, content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } });

const invalid = (message: string): never => { throw new HttpError(400, message); };

function parse<T extends z.ZodType>(type: T, value: unknown): z.infer<T> {
  const result = type.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0].message);
  return result.data;
}

export function api(context: ApiContext) {
  const app = new OpenAPIHono<Env>();
  const { accounts, clients } = context;
  // Bodies are read in handlers, after authentication and ownership checks and within
  // a size limit, so routes are documented here rather than validated by middleware.
  // `path` overrides the handler's path, for parameters that span segments.
  const route = (config: RouteConfig, handler: (c: Context<Env>) => Promise<Response> | Response, path = config.path.replaceAll(/{(\w+)}/g, ":$1")) => {
    app.openAPIRegistry.registerPath({ ...config, responses: { ...config.responses, ...failure } });
    app.on(config.method.toUpperCase(), path, handler);
  };
  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer", description: "Operator or API token" });
  app.openAPIRegistry.registerComponent("securitySchemes", "console", { type: "apiKey", in: "cookie", name: "ar_session", description: "Console session; mutations also need X-Agent-Runtime-Console: 1" });
  app.doc31("/v1/openapi.json", DOCUMENT);

  const volumes = () => {
    if (!context.volumes) throw new HttpError(404, "Volumes are not enabled on this runtime");
    return context.volumes;
  };
  const links = () => {
    if (!context.links) throw new HttpError(404, "Links are not enabled on this runtime");
    return context.links;
  };

  // A signed link is its own credential, so its routes come before the check below. The grant
  // still names a tenant, which must still own the volume.
  const linkRoute = { request: { params: z.object({ token: z.string(), name: z.string().openapi({ description: "The file's name, for browsers; not checked" }) }) }, security: [] };
  const granted = async (c: Context, method: "GET" | "PUT") => {
    const grant = links().verify(c.req.param("token")!);
    if (grant.method !== method) throw new HttpError(405, `This link is for ${grant.method}`);
    if (!await volumes().owns(grant.volume, grant.tenant)) throw new HttpError(404, "Unknown volume");
    return grant;
  };
  route(createRoute({ ...linkRoute, method: "get", path: "/v1/links/{token}/{name}", responses: { 200: binary("The file, with safe download headers"), 206: binary("The requested range") } }), async c => {
    const grant = await granted(c, "GET");
    const entry = await volumes().call(grant.volume, grant.tenant, "stat", { path: grant.path });
    if (entry.type !== "file") throw new HttpError(404, `${grant.path} is a directory`);
    return fileResponse(volumes(), grant.tenant, entry, c.req.header("range"));
  });
  route(createRoute({ ...linkRoute, method: "put", path: "/v1/links/{token}/{name}", request: { ...linkRoute.request, body: binary("The file's bytes, streamed; at most the link's maxBytes") }, responses: { 201: reply("The file's new version", schema.VolumeFile) } }), async c => {
    const grant = await granted(c, "PUT");
    const limit = Math.min(grant.maxBytes ?? VOLUME_LIMITS.fileBytes, VOLUME_LIMITS.fileBytes);
    if (Number(c.req.header("content-length") ?? 0) > limit) throw new HttpError(413, `This link takes at most ${limit} bytes`);
    const declared = declaredType(c.req.header("content-type"));
    if (grant.contentType && declared && declared !== grant.contentType) throw new HttpError(415, `This link takes ${grant.contentType}`);
    const { chunks: _chunks, ...entry } = await volumes().put(grant.tenant, grant.volume, grant.path, (c.req.raw.body ?? []) as AsyncIterable<Uint8Array>, { contentType: grant.contentType ?? declared, by: "link", limit });
    return json(c, 201, entry);
  });

  // Stripe's webhook authenticates by its signature, not a token, so it comes before the check below.
  app.post("/v1/billing/stripe/webhook", async c => {
    const payload = await readText(c.req.raw.body, 1024 * 1024);
    return json(c, 200, await accounts.billing.webhook(payload, c.req.header("stripe-signature")));
  });
  app.use("/v1/*", async (c, next) => {
    c.set("principal", await authenticate(c, context));
    await next();
  });
  app.use("/v1/agents/:id/*", async (c, next) => {
    if (!await clients.owns(c.req.param("id")!, c.var.principal.tenant)) throw new HttpError(404, "Unknown agent");
    await next();
  });

  route(createRoute({ method: "get", path: "/v1/me", responses: { 200: reply("The caller", schema.Me) } }), c => {
    const principal = c.var.principal;
    return json(c, 200, { tenant: principal.tenant, via: principal.via, ...("login" in principal ? { login: principal.login } : {}), canStoreKeys: accounts.canStoreKeys });
  });

  route(createRoute({ method: "get", path: "/v1/providers", responses: { 200: reply("Key status per provider", z.array(schema.Provider)) } }), async c => {
    const keys = new Map((await accounts.keyStatus(c.var.principal.tenant)).map(status => [status.provider, status]));
    return json(c, 200, listProviders().map(provider => ({ ...provider, key: keys.get(provider.id) ?? null })));
  });

  const provider = (c: Context) => {
    const info = providerInfo(c.req.param("provider")!);
    if (!info) throw new HttpError(404, `Unknown provider ${c.req.param("provider")}; see GET /v1/providers`);
    return info;
  };
  const providerKey = { method: "put", path: "/v1/providers/{provider}/key", request: { params: z.object({ provider: z.string() }) } } as const;
  route(createRoute({ ...providerKey, request: { ...providerKey.request, body: content(schema.KeyInput) }, responses: { 200: reply("The key is stored", schema.KeySet) } }), async c => {
    const info = provider(c), id = info.id;
    const tenant = c.var.principal.tenant;
    if (!info.apiKey) throw new HttpError(400, `${id} needs ${info.requires}, not just an API key; it is not supported yet`);
    if (!accounts.canStoreKeys) throw new HttpError(503, "This runtime is not configured to store provider keys");
    const { apiKey, verify } = parse(schema.KeyInput, await readJson(c.req.raw.body, 16 * 1024, {}));
    const check = verify === false || context.verifyKeys === false ? { status: "unverified" as const, detail: "Verification skipped" }
      // Checking a search or render key would cost a call: the first one checks it.
      : info.kind !== "model" ? { status: "unverified" as const, detail: `${id} has no free way to check a key; the first ${info.kind === "search" ? "web_search" : "rendered web_fetch"} will` } : await checkProviderKey(id, apiKey);
    if (check.status === "invalid") throw new HttpError(422, check.detail);
    await accounts.setKey(tenant, id, apiKey);
    await clients.providerKeyChanged(tenant, id);
    return json(c, 200, { provider: id, last4: apiKey.slice(-4), verification: check });
  });
  route(createRoute({ ...providerKey, method: "delete", responses: { 200: reply("The key is deleted", schema.Deleted) } }), async c => {
    const { id } = provider(c);
    const tenant = c.var.principal.tenant;
    if (!await accounts.deleteKey(tenant, id)) throw new HttpError(404, `No ${id} key set by this tenant`);
    await clients.providerKeyChanged(tenant, id);
    return json(c, 200, { deleted: true });
  });

  route(createRoute({
    method: "get", path: "/v1/models",
    request: { query: z.object({ provider: z.string().optional(), available: z.enum(["true"]).optional().openapi({ description: "Only models this tenant has a key for" }) }) },
    responses: { 200: reply("Models in the catalog", z.array(schema.Model)) },
  }), async c => {
    const available = c.req.query("available") === "true";
    const supported = new Set(listProviders().filter(entry => entry.apiKey).map(entry => entry.id));
    const keyed = await accounts.keyedProviders(c.var.principal.tenant);
    // The models declared on the tenant's own endpoints come first; they need no key.
    const endpoints = accounts.tenants.modelEndpoints(c.var.principal.tenant) ?? {};
    const own = Object.entries(endpoints).filter(([provider]) => [undefined, provider].includes(c.req.query("provider")))
      .flatMap(([provider, endpoint]) => Object.keys(endpoint.models ?? {}).map(id => ({ ...modelInfo(resolveModel(`${provider}/${id}`, endpoints)), available: true })));
    const models = [...own, ...listModels(c.req.query("provider")).map(model => ({ ...model, available: supported.has(model.provider) && keyed(model.provider) }))];
    return json(c, 200, available ? models.filter(model => model.available) : models);
  });

  route(createRoute({ method: "get", path: "/v1/agents", responses: { 200: reply("The tenant's agents", z.array(schema.AgentSummary)) } }),
    async c => json(c, 200, await clients.list(c.var.principal.tenant)));
  route(createRoute({
    method: "post", path: "/v1/agents",
    request: { headers: z.object({ "idempotency-key": z.string().optional().openapi({ description: "Provisioning with the same key returns the same agent" }) }), body: content(schema.AgentInput) },
    responses: { 201: reply("The agent and its scoped token", schema.AgentCreated) },
  }), async c => {
    const key = c.req.header("idempotency-key");
    return json(c, 201, await context.createAgent(c.var.principal.tenant, await readJson(c.req.raw.body, 18 * 1024 * 1024, {}), key));
  });
  route(createRoute({
    method: "get", path: "/v1/agents/{id}", request: { params: agentId, query: z.object({
      schemas: z.enum(["true"]).optional().openapi({ description: "Include each tool's input schema in toolSources" }),
      refresh: z.enum(["true"]).optional().openapi({ description: "List every MCP server now, connecting to it, rather than showing what was last listed. A running agent takes changes at its next start or reconfiguration" }),
    }) },
    responses: { 200: reply("The agent", schema.AgentDetail) },
  }), async c => {
    const id = c.req.param("id")!, tenant = c.var.principal.tenant;
    const detail = await clients.inspect(id, tenant);
    return json(c, 200, { ...detail, toolSources: await clients.toolSources(id, tenant, { schemas: c.req.query("schemas") === "true", refresh: c.req.query("refresh") === "true" }) });
  });
  route(createRoute({ method: "delete", path: "/v1/agents/{id}", request: { params: agentId }, responses: { 200: reply("The agent is deleted: it stops at once, and its stored data is purged shortly after", schema.Deleted) } }), async c => {
    await clients.destroyAgent(c.req.param("id")!, c.var.principal.tenant);
    return json(c, 200, { deleted: true });
  });
  route(createRoute({ method: "get", path: "/v1/agents/{id}/history", request: { params: agentId }, responses: { 200: reply("The transcript", schema.History) } }),
    async c => json(c, 200, await clients.agentHistory(c.req.param("id")!, c.var.principal.tenant)));
  route(createRoute({ method: "post", path: "/v1/agents/{id}/abort", request: { params: agentId }, responses: { 200: reply("The running turn is aborted", z.object({ aborted: z.literal(true) })) } }), async c => {
    await clients.abortAgent(c.req.param("id")!, c.var.principal.tenant);
    return json(c, 200, { aborted: true });
  });
  route(createRoute({ method: "post", path: "/v1/agents/{id}/prompt", request: { params: agentId, body: content(schema.PromptInput) }, responses: { 202: reply("The accepted request", schema.RequestRecord) } }), async c => {
    // Room for inline files (FILE_LIMITS.inlineBytes, as base64); larger ones are uploaded first.
    const body = parse(schema.PromptInput, await readJson(c.req.raw.body, 6 * 1024 * 1024, {}));
    return json(c, 202, await clients.submit(c.req.param("id")!, c.var.principal.tenant, { id: body.requestId ?? randomUUID(), method: "prompt", params: { text: body.text, ...(body.actor !== undefined ? { actor: body.actor } : {}), ...(body.from !== undefined ? { from: body.from } : {}), ...(body.files !== undefined ? { files: body.files } : {}) } }));
  });
  route(createRoute({
    method: "put", path: "/v1/agents/{id}/uploads/{requestId}/{name}", request: { params: agentId.extend({ requestId: z.string(), name: z.string() }), body: binary("The file's bytes, streamed") },
    responses: { 201: reply("The saved file, in the agent's workspace under uploads/<requestId>/; attach it to that request as {path}", schema.Upload) },
  }), async c => json(c, 201, await clients.uploadFor(c.req.param("id")!, c.var.principal.tenant, c.req.param("requestId")!, c.req.param("name")!, (c.req.raw.body ?? []) as AsyncIterable<Uint8Array>, c.req.header("content-type"))));
  route(createRoute({
    method: "patch", path: "/v1/agents/{id}/configuration", request: { params: agentId, body: content(schema.ConfigureInput) },
    responses: { 202: reply("Configuration accepted; poll its request for completion. Conversation history is preserved", schema.RequestRecord) },
  }), async c => {
    const { requestId, ...params } = parse(schema.ConfigureInput, await readJson(c.req.raw.body, 1024 * 1024, {}));
    const tenant = c.var.principal.tenant;
    // A model the agent could not call is refused now, not when the request runs.
    if (params.model !== undefined) {
      let provider: string;
      try { provider = resolveModel(params.model, accounts.tenants.modelEndpoints(tenant)).provider; } catch (error) { throw new HttpError(400, errorText(error)); }
      if (!await accounts.hasKey(tenant, provider)) throw new HttpError(400, `No ${provider} API key is configured for this tenant; set one with PUT /v1/providers/${provider}/key`);
    }
    const submit = context.submit ?? clients.submit.bind(clients);
    return json(c, 202, await submit(c.req.param("id")!, tenant, { id: requestId ?? randomUUID(), method: "configure", params }));
  });
  route(createRoute({
    method: "get", path: "/v1/agents/{id}/requests/{requestId}", request: { params: agentId.extend({ requestId: z.string() }) },
    responses: { 200: reply("The request and, once settled, its outcome", schema.RequestRecord) },
  }), async c => {
    const request = (await clients.inspect(c.req.param("id")!, c.var.principal.tenant)).requests.find(record => record.id === c.req.param("requestId"));
    if (!request) throw new HttpError(404, "Unknown request");
    return json(c, 200, request);
  });

  const inputState = z.object({ state: z.enum(["pending", "answered", "declined", "cancelled", "expired", "superseded"]).optional() });
  route(createRoute({ method: "get", path: "/v1/agents/{id}/inputs", request: { params: agentId, query: inputState }, responses: { 200: reply("The agent's human inputs, newest first", z.array(schema.Input)) } }),
    async c => json(c, 200, await clients.inputsFor(c.req.param("id")!, c.var.principal.tenant, c.req.query("state"))));
  route(createRoute({
    method: "post", path: "/v1/agents/{id}/inputs/{inputId}", request: { params: agentId.extend({ inputId: z.string() }), body: content(schema.AnswerInput) },
    responses: { 202: reply("The answer is recorded", schema.Answered), 200: reply("The same answer was recorded before", schema.Answered), 409: reply("The input had already settled otherwise", schema.ApiError) },
  }), async c => {
    const { status, inputs, requests } = await clients.answer(c.req.param("id")!, c.var.principal.tenant, [{ id: c.req.param("inputId")!, body: await readJson(c.req.raw.body, 256 * 1024, {}) }]);
    return json(c, status, { input: inputs[0], request: requests[0] ?? null });
  });
  route(createRoute({
    method: "post", path: "/v1/agents/{id}/inputs", request: { params: agentId, body: content(schema.AnswerInputs) },
    responses: { 202: reply("Every answer is recorded, or none is", schema.AnsweredAll), 200: reply("The same answers were recorded before", schema.AnsweredAll), 409: reply("An input had already settled otherwise", schema.ApiError) },
  }), async c => {
    const { status, ...answered } = await clients.answer(c.req.param("id")!, c.var.principal.tenant, answerList(await readJson(c.req.raw.body, 1024 * 1024, {})));
    return json(c, status, answered);
  });
  route(createRoute({ method: "get", path: "/v1/inputs", request: { query: inputState }, responses: { 200: reply("The tenant's human inputs across its agents, newest first: what waits on someone", z.array(schema.Input)) } }),
    async c => json(c, 200, await clients.inbox(c.var.principal.tenant, c.req.query("state"))));

  const scheduler = () => {
    if (!context.scheduler) throw new HttpError(404, "Unknown agent route");
    return context.scheduler;
  };
  route(createRoute({ method: "get", path: "/v1/agents/{id}/schedules", request: { params: agentId }, responses: { 200: reply("The agent's schedules", z.array(schema.Schedule)) } }),
    async c => json(c, 200, await scheduler().list(c.req.param("id")!)));
  route(createRoute({ method: "post", path: "/v1/agents/{id}/schedules", request: { params: agentId, body: content(schema.ScheduleInput) }, responses: { 201: reply("The schedule", schema.Schedule) } }), async c => {
    const schedules = scheduler();
    let input;
    try { input = scheduleInput(await readJson(c.req.raw.body, 64 * 1024, {})); } catch (error) { throw new HttpError(400, errorText(error)); }
    return json(c, 201, await schedules.create({ agent: c.req.param("id")!, tenant: c.var.principal.tenant, ...input }));
  });
  route(createRoute({ method: "delete", path: "/v1/agents/{id}/schedules/{scheduleId}", request: { params: agentId.extend({ scheduleId: z.string() }) }, responses: { 200: reply("The schedule is deleted", schema.Deleted) } }), async c => {
    if (!await scheduler().remove(c.req.param("id")!, c.req.param("scheduleId")!)) throw new HttpError(404, "Unknown schedule");
    return json(c, 200, { deleted: true });
  });

  route(createRoute({ method: "get", path: "/v1/tokens", responses: { 200: reply("The tenant's API tokens", z.array(schema.Token)) } }),
    async c => json(c, 200, await accounts.listTokens(c.var.principal.tenant)));
  route(createRoute({ method: "post", path: "/v1/tokens", request: { body: content(schema.TokenInput) }, responses: { 201: reply("The token, with its secret", schema.TokenCreated) } }), async c => {
    const body = await readJson(c.req.raw.body, 4096, {});
    return json(c, 201, await accounts.createToken(c.var.principal.tenant, body.name));
  });
  route(createRoute({ method: "delete", path: "/v1/tokens/{id}", request: { params: z.object({ id: z.string() }) }, responses: { 200: reply("The token is revoked", z.object({ revoked: z.literal(true) })) } }), async c => {
    const id = c.req.param("id")!;
    if (c.var.principal.tokenId === id) throw new HttpError(400, "A token cannot revoke itself; use another token or the console");
    if (!await accounts.revokeToken(c.var.principal.tenant, id)) throw new HttpError(404, "Unknown token");
    return json(c, 200, { revoked: true });
  });

  route(createRoute({
    method: "get", path: "/v1/usage", request: { query: z.object({ days: z.string().optional().openapi({ description: "1–365, default 30" }) }) },
    responses: { 200: reply("Token usage per UTC day and model", schema.Usage) },
  }), async c => {
    const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 30) || 30));
    return json(c, 200, await accounts.usage(c.var.principal.tenant, Date.now() - days * 86_400_000));
  });

  route(createRoute({ method: "get", path: "/v1/billing", responses: { 200: reply("Prepaid credit: balance, this month, recent entries and rates", schema.Billing) } }),
    async c => json(c, 200, await accounts.billing.summary(c.var.principal.tenant)));
  route(createRoute({
    method: "get", path: "/v1/billing/ledger",
    request: { query: z.object({ before: z.string().optional().openapi({ description: "Entries older than this id" }), limit: z.string().optional().openapi({ description: "1–200, default 50" }) }) },
    responses: { 200: reply("The credit ledger, newest first, a page at a time", schema.Ledger) },
  }), async c => {
    const before = c.req.query("before") === undefined ? undefined : Number(c.req.query("before"));
    if (before !== undefined && !Number.isSafeInteger(before)) throw new HttpError(400, "before must be a ledger entry id");
    return json(c, 200, await accounts.billing.ledger(c.var.principal.tenant, { before, limit: Number(c.req.query("limit") ?? 50) || 50 }));
  });
  route(createRoute({
    method: "post", path: "/v1/billing/checkout", request: { body: content(schema.CheckoutInput) },
    responses: { 201: reply("A Stripe Checkout session; the credit is added once Stripe reports the payment", schema.Checkout) },
  }), async c => {
    const { amountUsd } = parse(schema.CheckoutInput, await readJson(c.req.raw.body, 4096, {}));
    const amount = Math.round(amountUsd * 100) * 10_000;
    if (Math.abs(amountUsd * 100 - Math.round(amountUsd * 100)) > 1e-6) throw new HttpError(400, "amountUsd must be in whole cents");
    return json(c, 201, await accounts.billing.checkout(c.var.principal.tenant, amount));
  });
  route(createRoute({
    method: "post", path: "/v1/billing/adjustments", request: { body: content(schema.AdjustmentInput) },
    responses: { 201: reply("The entry, or the earlier one with the same idempotency key", schema.LedgerEntry) },
  }), async c => {
    const principal = c.var.principal;
    if (principal.via !== "operator" || !context.billingAdmins?.includes(principal.tenant)) throw new HttpError(403, "Only the platform operator can adjust credit");
    const body = parse(schema.AdjustmentInput, await readJson(c.req.raw.body, 4096, {}));
    if (!await accounts.exists(body.tenant)) throw new HttpError(404, `Unknown tenant ${body.tenant}`);
    const key = `adjustment:${body.idempotencyKey ?? randomUUID()}`;
    await accounts.billing.post([{ tenant: body.tenant, kind: "adjustment", amount: body.amount, key, metadata: { reason: body.reason, by: principal.tenant } }]);
    const row = (await accounts.db.query("select id, tenant, kind, amount, metadata, created_at from credit_ledger where idempotency_key = $1", [key])).rows[0];
    if (row.tenant !== body.tenant || row.amount !== body.amount) throw new HttpError(409, "Idempotency key reused with a different adjustment");
    return json(c, 201, { id: row.id, kind: row.kind, amount: row.amount, metadata: row.metadata, createdAt: row.created_at });
  });

  channelRoutes(route, () => context.channels);
  definitionRoutes(route, () => context);

  route(createRoute({ method: "get", path: "/v1/agents/{id}/mounts", request: { params: agentId }, responses: { 200: reply("The agent's mounts", z.array(schema.Mount)) } }),
    async c => json(c, 200, (await clients.inspect(c.req.param("id")!, c.var.principal.tenant)).mounts));
  route(createRoute({ method: "put", path: "/v1/agents/{id}/mounts", request: { params: agentId, body: content(schema.MountsInput) }, responses: { 200: reply("The agent's new mounts", z.array(schema.Mount)) } }), async c => {
    const body = await readJson(c.req.raw.body, 64 * 1024, {});
    return json(c, 200, await clients.setMounts(c.req.param("id")!, c.var.principal.tenant, body.mounts));
  });

  // Every /v1/volumes/<id> request is forwarded to the node that owns the volume before it gets here.
  const volumeId = z.object({ id: z.string() });
  const volume = async (c: Context<Env>) => {
    const id = c.req.param("id")!;
    if (!await volumes().owns(id, c.var.principal.tenant)) throw new HttpError(404, "Unknown volume");
    return { id, tenant: c.var.principal.tenant, call: (op: string, args: Record<string, unknown> = {}) => volumes().call(id, c.var.principal.tenant, op, args) };
  };
  route(createRoute({ method: "get", path: "/v1/volumes", responses: { 200: reply("The tenant's volumes", z.array(schema.VolumeSummary)) } }),
    async c => json(c, 200, await volumes().list(c.var.principal.tenant)));
  route(createRoute({ method: "post", path: "/v1/volumes", request: { body: content(schema.VolumeInput) }, responses: { 201: reply("The volume", schema.Volume) } }), async c => {
    const body = await readJson(c.req.raw.body, 4096, {});
    return json(c, 201, await volumes().create(c.var.principal.tenant, body));
  });
  route(createRoute({ method: "get", path: "/v1/volumes/{id}", request: { params: volumeId }, responses: { 200: reply("The volume", schema.Volume) } }),
    async c => json(c, 200, await (await volume(c)).call("info")));
  route(createRoute({ method: "delete", path: "/v1/volumes/{id}", request: { params: volumeId }, responses: { 200: reply("The volume is deleted; agents mounting it can no longer reach it", schema.Deleted) } }),
    async c => json(c, 200, await (await volume(c)).call("delete")));
  route(createRoute({ method: "get", path: "/v1/volumes/{id}/snapshots", request: { params: volumeId }, responses: { 200: reply("The volume's snapshots", z.array(schema.Snapshot)) } }),
    async c => json(c, 200, await (await volume(c)).call("snapshots")));
  route(createRoute({ method: "post", path: "/v1/volumes/{id}/snapshots", request: { params: volumeId, body: content(schema.VolumeInput) }, responses: { 201: reply("The snapshot: a copy of the file metadata, sharing contents", schema.Snapshot) } }), async c => {
    const target = await volume(c);
    return json(c, 201, await target.call("snapshot", await readJson(c.req.raw.body, 4096, {})));
  });
  route(createRoute({ method: "delete", path: "/v1/volumes/{id}/snapshots/{snapshotId}", request: { params: volumeId.extend({ snapshotId: z.string() }) }, responses: { 200: reply("The snapshot is deleted", schema.Deleted) } }),
    async c => json(c, 200, await (await volume(c)).call("deleteSnapshot", { snapshot: c.req.param("snapshotId") })));
  route(createRoute({ method: "post", path: "/v1/volumes/{id}/fork", request: { params: volumeId, body: content(schema.ForkInput) }, responses: { 201: reply("A new, independent volume with the same files", schema.Volume) } }), async c => {
    const target = await volume(c);
    const { name, snapshot } = await readJson(c.req.raw.body, 4096, {});
    return json(c, 201, await target.call("fork", { name, snapshot }));
  });
  route(createRoute({
    method: "post", path: "/v1/volumes/{id}/links", request: { params: volumeId, body: content(schema.LinkInput) },
    responses: { 201: reply("A signed URL for one file, usable without a token until it expires", schema.Link) },
  }), async c => {
    const target = await volume(c);
    const input = parse(schema.LinkInput, await readJson(c.req.raw.body, 4096, {}));
    return json(c, 201, links().sign({ tenant: target.tenant, volume: target.id, path: normalizePath(input.path), method: input.method ?? "GET", expiresIn: input.expiresIn,
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}), ...(input.contentType !== undefined ? { contentType: declaredType(input.contentType) ?? invalid("contentType must be a specific content type") } : {}) }));
  });
  route(createRoute({
    method: "get", path: "/v1/volumes/{id}/changes", request: { params: volumeId, query: z.object({ since: z.string().optional().openapi({ description: "Changes after this seq" }) }) },
    responses: { 200: reply("Recent changes, oldest first", schema.Changes) },
  }), async c => json(c, 200, await (await volume(c)).call("changes", { since: Number(c.req.query("since") ?? 0) || 0 })));
  route(createRoute({
    method: "get", path: "/v1/volumes/{id}/files", request: { params: volumeId, query: z.object({ prefix: z.string().optional(), glob: z.string().optional(), after: z.string().optional(), limit: z.string().optional() }) },
    responses: { 200: reply("Files under prefix, in path order, a page at a time", schema.FileList) },
  }), async c => {
    const { prefix, glob, after, limit } = c.req.query();
    const listing = await (await volume(c)).call("list", { path: prefix ?? "/", ...(glob ? { glob } : {}), ...(after ? { after } : {}), ...(limit ? { limit: Number(limit) } : {}) });
    return json(c, 200, { files: listing.files.map(({ chunks: _chunks, ...file }: { chunks: string[] }) => file), ...(listing.next ? { next: listing.next } : {}) });
  });
  const filePath = (c: Context) => {
    const encoded = new URL(c.req.url).pathname.split("/files/").slice(1).join("/files/");
    try { return normalizePath(`/${encoded.split("/").map(decodeURIComponent).join("/")}`); }
    catch { throw new HttpError(400, "Invalid file path"); }
  };
  const version = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const parsed = Number(value.replace(/^W\//, "").replaceAll('"', ""));
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, "If-Match must be a file version");
    return parsed;
  };
  const file = { params: volumeId.extend({ path: z.string().openapi({ description: "Path inside the volume; may contain /" }) }) };
  const files = "/v1/volumes/:id/files/*";
  route(createRoute({
    method: "put", path: "/v1/volumes/{id}/files/{path}",
    request: { ...file, headers: z.object({ "if-match": z.string().optional().openapi({ description: "Only replace this version" }), "if-none-match": z.string().optional().openapi({ description: "* to create only" }) }), body: binary("The file's bytes") },
    responses: { 201: reply("The file's new version", schema.VolumeFile) },
  }), async c => {
    const target = await volume(c);
    const path = filePath(c);
    const ifMatch = c.req.header("if-none-match") === "*" ? 0 : version(c.req.header("if-match"));
    const { chunks: _chunks, ...entry } = await volumes().put(target.tenant, target.id, path, (c.req.raw.body ?? []) as AsyncIterable<Uint8Array>, { contentType: c.req.header("content-type"), ifMatch });
    return json(c, 201, entry);
  }, files);
  route(createRoute({
    method: "get", path: "/v1/volumes/{id}/files/{path}", request: { ...file, headers: z.object({ range: z.string().optional().openapi({ description: "bytes=start-end" }) }) },
    responses: { 200: binary("The file, streamed a chunk at a time; ETag is its version"), 206: binary("The requested range") },
  }), async c => {
    const target = await volume(c);
    const entry = await target.call("stat", { path: filePath(c) });
    if (entry.type !== "file") throw new HttpError(404, `${entry.path} is a directory`);
    return fileResponse(volumes(), target.tenant, entry, c.req.header("range"));
  }, files);
  route(createRoute({
    method: "delete", path: "/v1/volumes/{id}/files/{path}", request: { ...file, headers: z.object({ "if-match": z.string().optional() }) },
    responses: { 200: reply("The file is deleted", z.object({ path: z.string(), deleted: z.literal(true), seq: z.number() })) },
  }), async c => {
    const target = await volume(c);
    const ifMatch = version(c.req.header("if-match"));
    return json(c, 200, await target.call("remove", { path: filePath(c), ...(ifMatch !== undefined ? { ifMatch } : {}) }));
  }, files);

  app.all("/v1/agents/:id/schedules/*", () => { scheduler(); throw new HttpError(404, "Unknown schedule route"); });
  app.all("/v1/agents/:id/*", () => { throw new HttpError(404, "Unknown agent route"); });
  app.all("/v1/*", () => { throw new HttpError(404, "Unknown API route"); });
  // A conflicting answer says what the input settled as.
  app.onError((error, c) => json(c, errorStatus(error, 400), { error: errorText(error), ...((error as { input?: unknown }).input ? { input: (error as { input?: unknown }).input } : {}) }));
  return app;
}

/** The OpenAPI document, without a running server (npm run openapi). */
export const openapiDocument = () => api({} as ApiContext).getOpenAPI31Document(DOCUMENT);

async function authenticate(c: Context, context: ApiContext): Promise<Principal & { login?: string }> {
  const authorization = c.req.header("authorization");
  if (authorization) {
    const principal = await context.accounts.authenticate(authorization);
    if (!principal) throw new HttpError(401, "Invalid token");
    return principal;
  }
  const principal = await context.consoleAuth.principal(c.req.raw);
  if (!principal) throw new HttpError(401, "Sign in, or send Authorization: Bearer <token>");
  if (!["GET", "HEAD"].includes(c.req.method) && !context.consoleAuth.allowsMutation(c.req.raw)) throw new HttpError(403, "Console requests must be same-origin");
  return principal;
}
