import { workerDreaming } from "./dreaming.ts";
import { SharedAgents, ShareLinkInput, MemberInput } from '../../../src/shared-agents.ts';
import { database } from './postgres.ts';
import { inboxQuery, readInbox, InboxQueryError } from '../../../shared/inbox.ts';
import { withSql as inboxSql } from './postgres.ts';
import { sweepInputMirrors } from "./input-mirror.ts";
import { HttpError as CoreHttpError } from "../../../src/core/http-error.ts";
import { serveToolFile } from './tool-files.ts';
import { withMoneyMetrics } from "./money-metrics.ts";
import { profileHttp } from "./db-profile.ts";
import { publicRoutes, publicPageHeaders, authenticationHint } from "./public-http.ts";
import { firstPrompt } from "./first-prompt.ts";
import { builtinWarnings } from "./builtin-warnings.ts";
import { serveAgentMcp, agentMcpPreflight, agentMcpSignIn } from "./agent-mcp.ts";
import { publicOrigins } from "./account-origins.ts";
import { serveHostedMcp } from "./hosted-mcp.ts";
import { resolveDefinition, definitionUpsert } from "./definitions.ts";
import { sweepComputers, sweepSnapshots } from './computers/service.ts';
import { CamelAgent, json, type Env } from "./agent.ts";
import {
  Directory,
  authenticate,
  controlRoutes,
  maintenance,
  creationRate,
  type DirectoryEntry,
  type DirectoryFailure,
} from "./control.ts";
import { agentToolView } from "./agent-tool-view.ts";
import { agentActivity } from "./agent-activity.ts";
import { listAgents } from "./agent-list.ts";
import { withMoneyIdempotency } from "./money-idempotency.ts";
import { skipMoneyIdempotency } from "./idempotency-routes.ts";
import { ApiError, agentToken, configuration } from "./api-contract.ts";
import { upsertAgent } from "./agent-upsert.ts";
import { configurationModelError } from "./default-model.ts";
import { authorized, agentId, BadRequest, body } from "./validation.ts";
import { HttpError, errorCode, errorStatus } from "./errors.ts";
import { handleAdminRequest } from "./admin-api.ts";
import { publicAdminSite } from "./admin-site.ts";
import { handleServiceRequest } from "./service-api.ts";
import { handleMediaRequest } from "./media-api.ts";
import { handleComputerRequest } from "./computers/api.ts";
import { websocketAuthorization } from "./live-transport.ts";
import { publishScheduleEmails, deliverScheduleEmail } from "./schedules.ts";
import { metric, failure } from "./observability.ts";
import { withSql } from "./postgres.ts";
import {
  consumeWebhooks,
  publishPending,
  resumeWebhookDeliveries,
  type DeliveryMessage,
} from "./webhooks.ts";
import { handleFileRequest, handleSignedFileRequest } from "./files.ts";
import { channelRoutes, channelWebhook } from "./channel-routes.ts";
import { githubAppRoutes } from "./github-app-routes.ts";
import { workerChannels } from "./channels.ts";
import { receiveChannelEmail } from "./channel-email.ts";
import { publicMoneyRoutes, authenticateMoney, moneyRoutes, moneyMaintenance, sendMoneyWebhooks, consumeAccountDeletionMessage } from "./money-api.ts";
import { BrowserTokens, type BrowserClaims } from "./browser-tokens.ts";
import { apiRequest, createAdmission, admissionError, admissionHeaders, errorFields, errorHeaders } from "./admission.ts";
import { BROWSER_READS, corsPreflight, corsResponse } from "./cors.ts";
import { browserResponse } from "./browser-response.ts";
import { browserUrl } from "./selfhost-policy.ts";
import { createJourney, sendJourney } from "./journey.ts";
import { flushJourney } from "./journey-delivery.ts";
import { keyServices } from "./security-services.ts";
import { eventRead } from "./event-reads.ts";
import { bridgeEvents, bridgeOptions, wantsEventStream } from "./sse-bridge.ts";
import { decisionService, type DecisionEnv } from "./decision-service.ts";
import { decisionRoute } from "./decision-runtime.ts";
import {
  definitionRoutes,
  provisionDefinition,
  visibleConfiguration,
  configurationPatch,
  withoutOnExpire,
} from "./definitions.ts";
import { statelessRoutes, agentLifecycleRoutes } from "./agent-routes.ts";
import { rotateAgentCredentials } from "./agent-credentials.ts";
import { modelCatalog } from "./model.ts";
import { rejectWorkflow } from "./workflow-refusal.ts";
import { providerRoutes } from "./provider-routes.ts";
import { TENANT_CONFIGURATION_KEYS } from "./access-policy.ts";
import {
  readAgentSpendLimit,
  agentSpendView,
} from "./agent-spend.ts";
export { CamelAgent };
export { TenantAdmission } from "./tenant.ts";
export { Volume } from "./volume.ts";
export { ContainerComputer } from "./computers/objects.ts";
export { ComputerEgress } from "./computers/egress-gateway.ts";

function result<T>(value: T | DirectoryFailure): T {
  if (
    value !== null &&
    typeof value === "object" &&
    "failed" in value &&
    value.failed === true
  ) {
    const failure = value as DirectoryFailure;
    throw new ApiError(failure.status, failure.error, failure.code);
  }
  return value as T;
}
function credentials(entry: DirectoryEntry, token?: string) {
  return {
    id: entry.id,
    ...(token === undefined ? {} : { token }),
    expiresAt: entry.expiresAt,
    configHash: entry.configHash,
  };
}
function summary(entry: DirectoryEntry) {
  return {
    ...visibleConfiguration(entry.config),
    tools: agentToolView(entry.config),
    ...(entry.config.definition ? { definition: { id: entry.config.definition, revision: entry.config.definitionRevision } } : {}),
    ...("forkedFrom" in entry ? { forkedFrom: entry.forkedFrom } : {}),
    ...(entry.parentAgentId ? { parentAgentId: entry.parentAgentId, parentRunId: entry.parentRunId } : {}),
    id: entry.id,
    key: entry.key,
    name: entry.config.name ?? "",
    type: entry.config.type ?? "agent",
    model: entry.config.model,
    connected: false,
    running: false,
    expiresAt: entry.expiresAt,
    configHash: entry.configHash,
    resume: null,
  };
}
async function forward(request: Request, env: Env, id: string, path: string, ctx: ExecutionContext) {
  const url = new URL(request.url);
  url.pathname = path;
  const agent = env.AGENTS.getByName(id);
  return agent.fetch(new Request(url, request), { signal: request.signal });
}
function scopedConfiguration(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new BadRequest("Expected configuration object");
  if (Object.hasOwn(input, "initialMessages") || Object.hasOwn(input, "importMessages"))
    throw new BadRequest("History can only be imported at creation");
  if (Object.hasOwn(input, "subject") || Object.hasOwn(input, "context"))
    throw new BadRequest("An agent's identity is set only at creation");
  for (const key of TENANT_CONFIGURATION_KEYS)
    if (Object.hasOwn(input, key))
      throw new ApiError(403, `Only the tenant can change an agent's ${key}`, "FORBIDDEN");
  for (const key of [
    "definition",
    "openApi",
    "subject",
    "context",
    "humanInput",
    "subagents",
    "workspaceId",
    "remount",
    "initialMessages",
    "importMessages",
  ])
    if (Object.hasOwn(input, key))
      throw new ApiError(
        key === "definition" ? 400 : 403,
        `Only the tenant can change an agent's ${key}`,
        key === "definition" ? "INVALID_REQUEST" : "FORBIDDEN",
      );
}

function shareInput<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'Invalid share settings', 'INVALID_REQUEST');
  return parsed.data;
}

function httpFailure(error: unknown, env: Env): Response {
  const limited = admissionError(error);
  if (limited) return limited;
  // The shared core's errors (src/core/http-error.ts: decision questions, channels) answer as this backend's own do.
  if (error instanceof ApiError || error instanceof HttpError || error instanceof CoreHttpError)
    return Response.json({ error: error.message, code: error.code ?? errorCode(error, error.status), ...errorFields(error), ...("details" in error ? error.details : {}) }, { status: error.status, headers: { 'cache-control': 'no-store', ...errorHeaders(error) } });
  if (error instanceof BadRequest || error instanceof URIError)
    return json({ error: error.message, code: "INVALID_REQUEST" }, 400);
  failure(env, "http_failed", error);
  const status = errorStatus(error, 500);
  return Response.json({ error: "Backend operation failed", code: errorCode(error, status) },
    { status, headers: { 'cache-control': 'no-store', ...errorHeaders(error) } });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const recovery = resumeWebhookDeliveries(env);
    if (recovery) ctx.waitUntil(recovery.catch(error => failure(env, "webhook_recovery_failed", error)));
    try {
      if (request.method === 'POST' && request.headers.has('idempotency-key') && !skipMoneyIdempotency(new URL(request.url).pathname)) {
        const auth = await authenticateMoney(request, env) ?? await authenticate(request, env);
        if (auth) {
          const response = (await withMoneyIdempotency(request, env, auth.tenantId, next => worker.fetchRequest(next, env, ctx)))!;
          return publicPageHeaders(request, corsResponse(request, response));
        }
      }
      return await worker.fetchRequest(request, env, ctx);
    } catch (error) {
      return publicPageHeaders(request, corsResponse(request, httpFailure(error, env)));
    }
  },
  async fetchRequest(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return profileHttp(env.PILOT_DB_PROFILE === "1", () => withMoneyMetrics(env, async () => publicPageHeaders(request, corsResponse(request, await (async () => {
    try {
      request = websocketAuthorization(request);
      if (request.method === "OPTIONS" && (/^\/v1\/agents\/client_[a-f0-9]{40}\/mcp$/.test(new URL(request.url).pathname) || new URL(request.url).pathname === "/mcp")) return agentMcpPreflight();
      const preflight = corsPreflight(request);
      if (preflight) return preflight;
      const callFile = await serveToolFile(request, env);
      if (callFile) return callFile;
      const signed = await handleSignedFileRequest(request, env);
      if (signed) return signed;
      const url = new URL(request.url),
        path = url.pathname;
      const adminSite = await publicAdminSite(request, env);
      if (adminSite) return adminSite;
      if (path === "/.well-known/openai-apps-challenge" && request.method === "GET") {
        const challenge = (env as Env & { AGENT_OPENAI_APPS_CHALLENGE?: string }).AGENT_OPENAI_APPS_CHALLENGE?.trim();
        return new Response(challenge || null, { status: challenge ? 200 : 404, headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" } });
      }
      if (path === "/healthz" && request.method === "GET")
        return json({
          ok: true,
          backend: "workers-native",
          experimental: true,
        });
      // Channels' webhooks come before any authentication: each delivery proves itself.
      const delivery = await channelWebhook(request, env, ctx);
      if (delivery) return delivery;
      const publicResponse = await publicRoutes(request, env);
      if (publicResponse) return publicResponse;
      const publicMoney = await publicMoneyRoutes(request, env, ctx);
      if (publicMoney) return publicMoney;
      if (path === "/console" || path.startsWith("/console/")) {
        return new Response("The console is not built on this host", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
      }
      if (path.startsWith("/api/"))
        return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
      await apiRequest(request, env);
      const bearer = request.headers.get("authorization") ?? undefined;
      const browserTokens = new BrowserTokens(env.AGENT_SESSION_SECRET ?? env.API_TOKEN);
      let browser: BrowserClaims | undefined;
      if (BrowserTokens.carries(bearer)) {
        browser = browserTokens.verify(bearer!);
        if (path.startsWith("/clients/") || path.startsWith("/registry/"))
          throw new ApiError(401, "An agent token is required", "UNAUTHORIZED");
        const scope = path.slice(path.lastIndexOf("/") + 1);
        if (request.method !== "GET" || !BROWSER_READS.test(path) || !browser.scopes.includes(scope as never) || (request.headers.has("upgrade") && (scope !== "events" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")))
          throw new ApiError(403, "This browser token does not grant this read", "FORBIDDEN");
      }
      let auth = browser ? null : await authenticateMoney(request, env)
        ?? (((env.TEST_MODE === "1" && !bearer?.startsWith("Bearer art_")) || await authorized(request, env.API_TOKEN)) ? await authenticate(request, env) : null);
      if (path === "/mcp") {
        if (!auth) return agentMcpSignIn(request, publicOrigins(env, url.origin).of(request.headers), "");
        const publicOrigin = env.AGENT_PUBLIC_URL || url.origin;
        return serveHostedMcp(request, { publicOrigin, fetch: (async (input, init) => {
          const local = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
          if (local.origin === new URL(publicOrigin).origin) local.host = url.host, local.protocol = url.protocol;
          return worker.fetch(new Request(local, input instanceof Request ? input : init), env, ctx);
        }) as typeof fetch });
      }
      const service = await handleServiceRequest(request, env, auth);
      if (service) return service;
      const match =
        /^\/(clients|v1\/agents|experimental\/agents)\/([^/]+)(\/.*)?$/.exec(
          path,
        );
      let entry: DirectoryEntry | null = null;
      if (match?.[1] === "clients" && auth)
        throw new ApiError(401, "An agent token is required", "UNAUTHORIZED");
      if (match) {
        const idOrKey = agentId(decodeURIComponent(match[2]));
        if (auth) entry = await new Directory(env, auth.tenantId).get(idOrKey);
        else if (browser && browser.agent === idOrKey)
          entry = await new Directory(env, browser.tenant).get(idOrKey);
        else if (browser) {
          const candidate = await new Directory(env, browser.tenant).get(idOrKey);
          if (!candidate || !browser.scopes.includes('children') || !await env.AGENTS.getByName(browser.agent).hasBackgroundChild(candidate.id))
            throw new ApiError(403, 'This browser token does not grant this agent', 'FORBIDDEN');
          entry = candidate;
        }
        else if (
          (match[1] !== "v1/agents" || match[3] === "/mcp") &&
          /^client_[a-f0-9]{40}$/.test(idOrKey)
        ) {
          const candidate =
            (
              await withSql(
                env,
                async (sql) =>
                  (
                    await sql.query(
                      "SELECT header,revoked FROM agents WHERE id=$1",
                      [idOrKey],
                    )
                  ).rows,
              )
            ).map((row) => ({
              ...row.header,
              ...(row.revoked ? { deleted: true } : {}),
            }))[0] ?? null;
          if (candidate && await authorized(request, await agentToken(env.API_TOKEN, idOrKey, candidate.tokenVersion))) entry = candidate;
        }
      }
      if (!auth && !entry && match?.[1] === "v1/agents" && match[3] === "/mcp")
        return agentMcpSignIn(request, env.AGENT_PUBLIC_URL || url.origin, match[2]);
      if (!auth && !entry)
        throw new ApiError(401, authenticationHint(request, env.AGENT_PUBLIC_URL || url.origin), "UNAUTHORIZED");
      if (auth) {
        const computers = await handleComputerRequest(request, env, auth);
        if (computers) return computers;
      }
      if (!match) {
        if (!auth) throw new ApiError(403, "Account key required", "FORBIDDEN");
        if (
          env.RATE_LIMITER &&
          !(await env.RATE_LIMITER.limit({ key: auth.tenantId })).success
        )
          throw new ApiError(429, "Rate limit exceeded", "RATE_LIMITED");
        if (
          path === "/__test/flush-webhooks" &&
          env.TEST_MODE === "1" &&
          auth.kind === "operator" &&
          request.method === "POST"
        )
          return json({ queued: await publishPending(env) });
        const money = await moneyRoutes(request, env, auth, ctx);
        if (money) return money;
        const admin = await handleAdminRequest(request, env, auth);
        if (admin) return admin;
        if (path === "/v1/decisions") {
          const decisions = decisionService(
            env as Env & DecisionEnv,
            async () => ({ tenant: auth!.tenantId }),
          );
          const response = await decisionRoute(request, decisions);
          if (response) { ctx.waitUntil(sendMoneyWebhooks(env)); return response; }
        }
        const control = await controlRoutes(request, env, auth);
        if (control) return control;
        if ((path === "/v1/inputs" || path === "/v1/inbox") && request.method === "GET") {
          try {
            const query = inboxQuery(url.searchParams);
            return json(await inboxSql(env, sql => readInbox(sql, auth.tenantId, query)));
          } catch (error) { if (error instanceof InboxQueryError) throw new ApiError(400, error.message); throw error; }
        }
        const media = await handleMediaRequest(request, env, auth);
        if (media) return media;
        const files = await handleFileRequest(request, env, auth);
        if (files) return files;
        const definition = await definitionRoutes(request, env, auth);
        if (definition) return definition;
        const channel = await channelRoutes(request, env, auth.tenantId, ctx);
        if (channel) return channel;
        const githubApp = await githubAppRoutes(request, env, auth);
        if (githubApp) return githubApp;
        const provider = await providerRoutes(request, env, auth);
        if (provider) return provider;
        const run = await statelessRoutes(request, env, auth);
        if (run) return run;
        if (path === "/v1/models" && request.method === "GET")
          return json(
            modelCatalog(env, url.searchParams.get("provider") ?? undefined),
          );
        if (path === "/v1/agents" && request.method === "POST") {
          const input = await body(request.clone(), 17 * 1024 * 1024) as { prompt?: { endUser?: unknown } };
          if (input?.prompt?.endUser !== undefined && !["operator", "api"].includes(auth.kind)) throw new HttpError(403, "Only a tenant key can choose a run payer");
        }
        if (path === "/v1/agents") {
          const directory = new Directory(env, auth.tenantId);
          if (request.method === "GET")
            return listAgents(request, env, auth.tenantId, directory, summary);
          if (request.method === "POST") {
            const raw = await body(request, 17 * 1024 * 1024);
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
              throw new BadRequest("Expected configuration object");
            const first = firstPrompt((raw as { prompt?: unknown }).prompt);
            const { prompt: _prompt, ...settings } = raw as Record<string, unknown>;
            const provisioned = await provisionDefinition(
              env,
              auth.tenantId,
              settings,
            );
            const key = request.headers.get("Idempotency-Key") ?? undefined;
            const input = key && typeof provisioned.definition === "string"
              ? definitionUpsert(provisioned, (await directory.get(key))?.config)
              : provisioned;
            configuration(input, env.MODEL);
            const upsert = await upsertAgent(env, auth.tenantId, input, key, url.origin);
            const created = result(upsert.entry);
            if (env.AGENT_JOURNEY_URL) {
              const { accounts } = await keyServices(env);
              const journey = createJourney(env, accounts, env.AGENT_PUBLIC_URL || url.origin);
              if (journey) {
                // A reused key has a configuration update, not another creation.
                if (!created.existingAgent && !created.reconfigured) {
                  await journey.agentCreated({ tenant: auth.tenantId, via: auth.kind === 'console' ? 'console' : auth.kind === 'oauth' ? 'mcp' : 'api', ...(auth.kind === 'console' ? { browser: journey.browser(request) } : {}) });
                }
                ctx.waitUntil(flushJourney(journey));
              }
            }
            const answer = { ...credentials(created, auth.kind === "oauth" ? undefined : await agentToken(env.API_TOKEN, created.id, created.tokenVersion)), ...(created.reconfigured ? { reconfigured: created.reconfigured } : {}), ...await builtinWarnings(env, auth.tenantId, created.config) };
            const headers = admissionHeaders(creationRate(created) ?? await createAdmission(env, auth.tenantId, false));
            if (!first) return Response.json(answer, { status: 201, headers });
            const submitted = await env.AGENTS.getByName(created.id).fetch(new Request("https://agent/requests", {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(first),
            }));
            const sent = await submitted.json() as { error?: string; code?: string };
            return Response.json({ ...answer, prompt: submitted.ok ? sent : { error: { status: submitted.status, code: sent.code ?? "INVALID_REQUEST", message: sent.error } } }, { status: 201, headers });
          }
        }
        throw new ApiError(404, "Unknown API route", "NOT_FOUND");
      }
      if (!entry || entry.config.type === "run") throw new ApiError(404, "Unknown agent", "NOT_FOUND");
      const tail = match[3] || "/";
      if (tail === "/configuration-target" || tail === "/upsert") throw new ApiError(404, "Not found", "NOT_FOUND");
      // Internal computer operations are reachable only through the service
      // binding. Public cleanup must use the account-scoped confirmation route.
      if (tail === "/__computer" && env.TEST_MODE !== "1")
        throw new ApiError(404, "Not found", "NOT_FOUND");
      const directory = new Directory(env, entry.tenantId);
      if (entry.deleted) {
        if ((auth || browser || ["/", "/credentials"].includes(tail)) && request.method === "GET")
          throw new ApiError(404, "Unknown agent", "NOT_FOUND");
        if (auth && tail === "/" && request.method === "DELETE") {
          result(await directory.remove(entry.id));
          return json({ deleted: true });
        }
        throw new ApiError(410, "Agent is deleted", "AGENT_GONE");
      }
      if (entry.expiresAt && entry.expiresAt <= Date.now())
        throw new ApiError(410, "Agent expired", "AGENT_EXPIRED");
      if (!entry.initialized && !["/credentials", "/credentials/rotate"].includes(tail))
        throw new ApiError(
          503,
          "Agent initialization is pending; retry creation",
          "INITIALIZATION_PENDING",
        );
      const shareRoute = /^\/(share-links|members)(?:\/([^/]+))?$/.exec(tail);
      if (shareRoute) {
        if (!auth || auth.kind === 'oauth' || match[1] !== 'v1/agents') throw new ApiError(403, 'An owner API key or console session is required', 'FORBIDDEN');
        const shared = new SharedAgents(database(env));
        const [, resource, item] = shareRoute;
        const tenant = entry.tenantId, agent = entry.id;
        if (resource === 'share-links') {
          if (!item && request.method === 'POST') return json(await shared.create(tenant, agent, shareInput(ShareLinkInput, await body(request, 4096, true)), env.AGENT_PUBLIC_URL || url.origin), 201);
          if (!item && request.method === 'GET') return json(await shared.links(tenant, agent));
          if (item && request.method === 'DELETE') { await shared.revoke(tenant, agent, item); return json({ deleted: true }); }
        } else {
          if (!item && request.method === 'GET') return json(await shared.members(tenant, agent));
          if (item && request.method === 'PATCH') {
            await shared.change(tenant, agent, item, shareInput(MemberInput, await body(request, 4096)));
            return json((await shared.members(tenant, agent)).find(m => m.id === item));
          }
          if (item && request.method === 'DELETE') {
            await shared.change(tenant, agent, item, 'remove');
            await env.AGENTS.getByName(agent).removeMember(item);
            return json({ deleted: true });
          }
        }
        throw new ApiError(404, 'Unknown API route', 'NOT_FOUND');
      }
      if (tail === "/mcp" && match[1] === "v1/agents") {
        const definition = entry.config.definition
          ? await resolveDefinition(env, entry.tenantId, entry.config.definition).catch(() => undefined)
          : undefined;
        return serveAgentMcp(request, {
          agent: { id: entry.id, name: entry.config.name, own: !auth },
          description: definition?.spec.description,
          publicOrigin: env.AGENT_PUBLIC_URL || url.origin,
          base: `${url.origin}${auth ? "/v1/agents/" : "/clients/"}${entry.id}`,
          fetch: (input, init) => worker.fetch(new Request(input, init), env, ctx),
        });
      }
      if (tail === "/browser-tokens" && request.method === "POST") {
        if (!auth || auth.kind === "oauth") throw new ApiError(403, "Account key required", "FORBIDDEN");
        const publicBrowser = browserUrl(env, url.origin);
        return json({ ...browserTokens.mint(entry.tenantId, entry.id, await body(request, 16 * 1024)), agentId: entry.id, ...(publicBrowser ? { url: publicBrowser } : {}) }, 201);
      }
      if (tail === "/credentials/rotate" && request.method === "POST") {
        if (!auth) throw new ApiError(401, "Account key required", "UNAUTHORIZED");
        return json(await rotateAgentCredentials(env, entry));
      }
      if (tail === "/credentials" && request.method === "GET") {
        if (!auth) throw new ApiError(401, "Account key required", "UNAUTHORIZED");
        if (!entry.key && !entry.tokenVersion) throw new ApiError(409, "AGENT_KEYLESS: this agent was made without a key, so its token is only what its create answered", "AGENT_KEYLESS");
        return json(
          credentials(entry, await agentToken(env.API_TOKEN, entry.id, entry.tokenVersion)),
        );
      }
      if (tail === "/" && request.method === "DELETE") {
        result(await directory.remove(entry.id));
        return json({ deleted: true });
      }
      if (tail === "/" && request.method === "GET") {
        const response = await forward(
          new Request(request.url, { headers: request.headers }),
          env,
          entry.id,
          "/tool-sources",
          ctx,
        );
        if (!response.ok) return response;
        const stateResponse = await forward(
          new Request(request.url, { headers: request.headers }), env, entry.id, "/state", ctx,
        );
        if (!stateResponse.ok) return stateResponse;
        const state = await stateResponse.json() as { requests: { state: string }[]; cursor: number; running: boolean; spendLimit?: unknown };
        return json({
          ...summary(entry),
          ...await agentActivity(env, entry.tenantId, entry.id),
          ...state,
          spendLimit: state.spendLimit ?? agentSpendView(
            await readAgentSpendLimit(env, entry.tenantId, entry.id),
          ),
          toolSources: await response.json(),
        });
      }
      if (tail === "/" && request.method === "PATCH") {
        if (!auth) throw new ApiError(403, "Account key required", "FORBIDDEN");
        const input = await body(request);
        if (
          !input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some((key) => !["name", "type"].includes(key))
        )
          throw new BadRequest("Only name and type may be patched here");
        return json(summary(result(await directory.upsert(
          { ...entry.config, ...input }, entry.key ?? entry.id, url.origin,
        ))));
      }
      if (tail === "/metadata" && request.method === "POST") {
        const input = await body(request, 4096);
        if (
          !input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some((key) => !["name", "type"].includes(key))
        )
          throw new BadRequest("Expected name and type");
        const next = result(await directory.upsert(
          { ...entry.config, ...input }, entry.key ?? entry.id, url.origin,
        ));
        return json({ name: next.config.name ?? "", type: next.config.type ?? "agent" });
      }
      if (tail === "/configuration") {
        if (request.method === "GET") return json(visibleConfiguration(entry.config));
        if (!["PUT", "PATCH"].includes(request.method))
          throw new ApiError(405, "Method not allowed");
        const next = await body(request);
        if (!next || typeof next !== "object" || Array.isArray(next))
          throw new BadRequest("Expected configuration object");
        const { requestId, ...params } = next as Record<string, unknown>;
        if (!auth) scopedConfiguration(params);
        rejectWorkflow(params);
        if (auth) {
          const allowed = new Set(["model", "systemPrompt", "systemPromptAppend", "thinkingLevel", "maxOutputTokens", "temperature", "dataCollection", "language", "queue", "keyScope", "spendLimit", "bucket", "runLimits", "modelHeaders", "builtins", "decide", "delegate", "mcpServers"]);
          const unknown = Object.keys(params).find(field => !allowed.has(field));
          if (unknown) throw new BadRequest(`Unsupported field: ${unknown}`);
        }
        if (requestId !== undefined && (typeof requestId !== "string" || !requestId.length))
          throw new BadRequest("requestId must be a nonempty string");
        const patched = configuration({ ...withoutOnExpire(entry.config), ...params }, entry.config.model ?? env.MODEL, "patch").config;
        if (Object.hasOwn(params, "model") || Object.hasOwn(params, "keyScope")) {
          try {
            const modelError = await configurationModelError(env, entry.tenantId, patched);
            if (modelError) throw new Error(modelError);
          } catch (error) { throw new ApiError(400, (error as Error).message); }
        }
        return forward(new Request(request.url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: requestId ?? request.headers.get("Idempotency-Key") ?? crypto.randomUUID(), method: "configure", params }),
        }), env, entry.id, "/requests", ctx);
      }
      if (tail === "/mounts") {
        if (request.method === "GET")
          return json(entry.config.mounts ?? []);
        if (request.method === "PUT") {
          if (!auth) throw new ApiError(403, "Account key required", "FORBIDDEN");
          const input = (await body(request)) as { mounts?: unknown[] };
          const updated = result(
            await directory.upsert(
              { ...entry.config, mounts: input.mounts, remount: true },
              entry.key ?? entry.id,
            ),
          );
          return json(updated.config.mounts);
        }
      }
      if (
        match[1] === "experimental/agents" &&
        tail.startsWith("/__test/") &&
        env.TEST_MODEL !== "1"
      )
        throw new ApiError(404, "Not found");
      if (tail === "/_input-mirror") throw new ApiError(404, "Not found");
      if (["/sessions", "/dreaming", "/dreaming/run"].includes(tail) && (!auth || match[1] !== "v1/agents"))
        throw new ApiError(403, "A tenant key is required", "FORBIDDEN");
      const lifecycle = !browser
        ? await agentLifecycleRoutes(request, env, entry, tail, auth?.kind !== "oauth", work => ctx.waitUntil(work))
        : undefined;
      if (lifecycle) return lifecycle;
      if (request.method === "POST" && ["/prompt", "/requests"].includes(tail)) {
        const payerInput = await body(request.clone(), (tail === "/prompt" ? 7 : 6) * 1024 * 1024) as { endUser?: unknown; params?: { endUser?: unknown } };
        if ((payerInput?.endUser !== undefined || payerInput?.params?.endUser !== undefined) && (!auth || !["operator", "api"].includes(auth.kind))) throw new HttpError(403, "Only a tenant key can choose a run payer");
      }
      if (tail === "/requests" && request.method === "POST") {
        const input = (await body(request.clone(), 6 * 1024 * 1024)) as { method?: string; params?: Record<string, unknown> };
        if (!auth && input?.method === "configure") scopedConfiguration(input.params);
        if (input?.method !== "configure" && input?.params?.bucket !== undefined &&
          (!auth || !["prompt", "steer", "continue"].includes(input.method ?? "")))
          throw new HttpError(auth ? 400 : 403, auth
            ? "bucket is for a model run (prompt, steer, continue)"
            : "Only the tenant can choose a run's bucket");
      }
      if (tail === "/inputs" || tail.startsWith("/inputs/")) {
        const headers = new Headers(request.headers);
        headers.set("x-camel-input-via", match[1] === "clients" ? "agent" : "api");
        request = new Request(request, { headers });
      }
      if (tail === "/events") {
        const eventUrl = new URL(request.url), headers = new Headers(request.headers);
        headers.set("x-camel-events-path", eventUrl.pathname);
        if (match[1] === "v1/agents" || browser) eventUrl.searchParams.set("watch", "1");
        request = new Request(eventUrl, { method: request.method, headers, signal: request.signal });
      }
      if (tail === '/prompt' && request.method === 'POST' && request.headers.has('idempotency-key')) {
        const input = await body(request, 6 * 1024 * 1024) as Record<string, unknown>;
        request = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify({ ...input, requestId: request.headers.get('idempotency-key') }) });
      }
      const trustedHeaders = new Headers(request.headers);
      trustedHeaders.delete("x-camel-shared-owner");
      if (auth?.kind === "console" && tail === "/prompt") trustedHeaders.set("x-camel-shared-owner", "1");
      request = new Request(request, { headers: trustedHeaders });
      const response = tail === "/events" && wantsEventStream(request)
        ? await bridgeEvents(request, request => forward(request, env, entry!.id, tail, ctx), bridgeOptions(env))
        : tail === "/events"
        ? await eventRead(request, env, entry.tenantId, entry.id, request => forward(request, env, entry!.id, tail, ctx), task => ctx.waitUntil(task))
        : await forward(request, env, entry.id, tail, ctx);
      return browser ? browserResponse(response, browser, tail) : response;
    } catch (error) {
      return httpFailure(error, env);
    }
    })()))));
  },
  async queue(batch: MessageBatch<DeliveryMessage>, env: Env) {
    return withMoneyMetrics(env, async () => {
    for (const message of batch.messages.filter(message => message.body.kind === "account_deletion")) {
      try { await consumeAccountDeletionMessage(env, message); }
      catch (error) { failure(env, "account_deletion_queue_failed", error); message.retry({ delaySeconds: 60 }); }
    }
    const deliveries = batch.messages.filter(message => message.body.kind !== "account_deletion");
    if (!deliveries.length) return;
    // A channel item came due (a retry, a debounce, a turn whose end was not seen): scan for due work.
    const channelWakes = deliveries.filter(message => message.body.kind === "channels");
    if (channelWakes.length) {
      try { await (await workerChannels(env)).scan(); for (const message of channelWakes) message.ack(); }
      catch (error) { failure(env, "channel_scan_failed", error); for (const message of channelWakes) message.retry({ delaySeconds: 30 }); }
    }
    if (channelWakes.length === deliveries.length) return;
    const webhookRetry = await sendMoneyWebhooks(env);
    for (const message of deliveries.filter(message => message.body.kind === "schedule")) {
      try { if (await deliverScheduleEmail(env, message.body.id)) message.ack(); else message.retry({ delaySeconds: 10 }); }
      catch { message.retry({ delaySeconds: 30 }); }
    }
    await consumeWebhooks({ ...batch, messages: deliveries.filter(message => message.body.kind === "email") } as MessageBatch<DeliveryMessage>, env);
    const webhookMessages = deliveries.filter(message => message.body.kind !== "email" && message.body.kind !== "schedule" && message.body.kind !== "channels");
    // The outbox owns backoff and expiry. Queue delivery retries must not cap it.
    if (webhookRetry !== undefined && webhookMessages.length) {
      if (!env.WEBHOOKS) throw new Error("Webhook queue is not configured");
      await env.WEBHOOKS.send(webhookMessages[0].body, { delaySeconds: Math.min(43_200, webhookRetry) });
    }
    for (const message of webhookMessages) message.ack();
    });
  },
  /** Mail Email Routing delivers to this Worker: each message for an email channel's address. */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    await receiveChannelEmail(message, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    return withMoneyMetrics(env, async () => {
    try {
      if (_controller.cron === "* * * * *") { await sweepInputMirrors(env); await workerDreaming(env).scan(); return; }
      await maintenance(env);
      await moneyMaintenance(env);
      await publishScheduleEmails(env);
      await sweepComputers(env);
      await sweepSnapshots(env);
      await sendJourney(env);
      // The backstop for channel work whose wake was lost or is further out than a queue delay.
      await (await workerChannels(env)).scan();
      metric(env, "maintenance", { MaintenanceRuns: 1 });
    } catch (error) { failure(env, "maintenance_failed", error); throw error; }
    });
  },
};
export default worker satisfies ExportedHandler<Env, DeliveryMessage>;
