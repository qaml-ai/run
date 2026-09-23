import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Accounts, Principal } from "./accounts.ts";
import type { ClientSessions } from "./client-sessions.ts";
import type { ConsoleAuth } from "./console-auth.ts";
import { listModels, listProviders, providerInfo } from "./catalog.ts";
import { checkProviderKey } from "./key-check.ts";
import { errorText } from "./protocol.ts";
import { scheduleInput, type Scheduler } from "./scheduler.ts";
import { HttpError, readJson } from "./http.ts";
import type { Channels } from "./channels.ts";
import { channelRoutes } from "./channels-api.ts";
import * as schema from "./api-schemas.ts";

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
  const route = (config: RouteConfig, handler: (c: Context<Env>) => Promise<Response> | Response) => {
    app.openAPIRegistry.registerPath({ ...config, responses: { ...config.responses, ...failure } });
    app.on(config.method.toUpperCase(), config.path.replaceAll(/{(\w+)}/g, ":$1"), handler);
  };
  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer", description: "Operator or API token" });
  app.openAPIRegistry.registerComponent("securitySchemes", "console", { type: "apiKey", in: "cookie", name: "ar_session", description: "Console session; mutations also need X-Agent-Runtime-Console: 1" });
  app.doc31("/v1/openapi.json", DOCUMENT);

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
    const wildcard = keys.get("*");
    return json(c, 200, listProviders().map(provider => ({ ...provider, key: keys.get(provider.id) ?? (wildcard && provider.apiKey ? wildcard : null) })));
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
    const check = verify === false || context.verifyKeys === false ? { status: "unverified" as const, detail: "Verification skipped" } : await checkProviderKey(id, apiKey);
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
    const models = listModels(c.req.query("provider")).map(model => ({ ...model, available: supported.has(model.provider) && keyed(model.provider) }));
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
  route(createRoute({ method: "get", path: "/v1/agents/{id}", request: { params: agentId }, responses: { 200: reply("The agent", schema.AgentDetail) } }),
    async c => json(c, 200, await clients.inspect(c.req.param("id")!, c.var.principal.tenant)));
  route(createRoute({ method: "delete", path: "/v1/agents/{id}", request: { params: agentId }, responses: { 200: reply("The agent is revoked", schema.Deleted) } }), async c => {
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
    const body = parse(schema.PromptInput, await readJson(c.req.raw.body, 1024 * 1024, {}));
    return json(c, 202, await clients.submit(c.req.param("id")!, c.var.principal.tenant, { id: body.requestId ?? randomUUID(), method: "prompt", params: { text: body.text } }));
  });
  route(createRoute({
    method: "get", path: "/v1/agents/{id}/requests/{requestId}", request: { params: agentId.extend({ requestId: z.string() }) },
    responses: { 200: reply("The request and, once settled, its outcome", schema.RequestRecord) },
  }), async c => {
    const request = (await clients.inspect(c.req.param("id")!, c.var.principal.tenant)).requests.find(record => record.id === c.req.param("requestId"));
    if (!request) throw new HttpError(404, "Unknown request");
    return json(c, 200, request);
  });

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

  channelRoutes(route, () => context.channels);

  app.all("/v1/agents/:id/schedules/*", () => { scheduler(); throw new HttpError(404, "Unknown schedule route"); });
  app.all("/v1/agents/:id/*", () => { throw new HttpError(404, "Unknown agent route"); });
  app.all("/v1/*", () => { throw new HttpError(404, "Unknown API route"); });
  app.onError((error, c) => json(c, (error as { status?: number }).status ?? 400, { error: errorText(error) }));
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
