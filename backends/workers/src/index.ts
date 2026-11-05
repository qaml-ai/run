import { serveToolFile } from './tool-files.ts';
import { withMoneyMetrics } from "./money-metrics.ts";
import { firstPrompt } from "./first-prompt.ts";
import { builtinWarnings } from "./builtin-warnings.ts";
import { serveAgentMcp, agentMcpPreflight, agentMcpSignIn } from "./agent-mcp.ts";
import { publicOrigins } from "./account-origins.ts";
import { serveHostedMcp } from "./hosted-mcp.ts";
import { publicDocs } from "./public-docs.ts";
import { resolveDefinition, definitionUpsert } from "./definitions.ts";
import { sweepComputers } from './computers/service.ts';
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
  type DeliveryMessage,
} from "./webhooks.ts";
import { handleFileRequest, handleSignedFileRequest } from "./files.ts";
import { publicMoneyRoutes, authenticateMoney, moneyRoutes, moneyMaintenance, sendMoneyWebhooks } from "./money-api.ts";
import { BrowserTokens, type BrowserClaims } from "./browser-tokens.ts";
import { apiRequest, createAdmission, admissionError, admissionHeaders, errorFields, errorHeaders } from "./admission.ts";
import { BROWSER_READS, corsPreflight, corsResponse } from "./cors.ts";
import { browserResponse } from "./browser-response.ts";
import { browserUrl } from "./selfhost-policy.ts";
import { createJourney, sendJourney } from "./journey.ts";
import { keyServices } from "./security-services.ts";
import { eventRead } from "./event-reads.ts";
import { decisionService, type DecisionEnv } from "./decision-service.ts";
import { decisionRoute } from "./decision-runtime.ts";
import {
  definitionRoutes,
  provisionDefinition,
  visibleConfiguration,
  configurationPatch,
} from "./definitions.ts";
import { statelessRoutes, agentLifecycleRoutes } from "./agent-routes.ts";
import { modelCatalog } from "./model.ts";
import { providerRoutes } from "./provider-routes.ts";
import { TENANT_CONFIGURATION_KEYS } from "./access-policy.ts";
import {
  readAgentSpendLimit,
  setAgentSpendLimit,
  agentSpendView,
} from "./agent-spend.ts";
export { CamelAgent };
export { TenantAdmission } from "./tenant.ts";
export { Volume } from "./volume.ts";
export { ContainerComputer, SandboxComputer } from "./computers/objects.ts";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

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
    ...(entry.reconfigured ? { reconfigured: true } : {}),
  };
}
function summary(entry: DirectoryEntry) {
  return {
    ...visibleConfiguration(entry.config),
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
async function forward(request: Request, env: Env, id: string, path: string) {
  const url = new URL(request.url);
  url.pathname = path;
  return env.AGENTS.getByName(id).fetch(new Request(url, request));
}
function scopedConfiguration(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new BadRequest("Expected configuration object");
  if (Object.hasOwn(input, "initialMessages") || Object.hasOwn(input, "importMessages"))
    throw new BadRequest("History can only be imported at creation");
  for (const key of [
    ...TENANT_CONFIGURATION_KEYS,
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

const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return withMoneyMetrics(env, async () => corsResponse(request, await (async () => {
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
      const docs = await publicDocs(request, env);
      if (docs) return docs;
      const publicMoney = await publicMoneyRoutes(request, env, ctx);
      if (publicMoney) return publicMoney;
      if (path === "/console" || path.startsWith("/console/")) {
        if (env.CONSOLE_ASSETS && ["GET", "HEAD"].includes(request.method)) {
          const asset = new URL(request.url);
          // Asset HTML handling canonicalizes /index.html to /. Fetch that
          // canonical path so its redirect cannot escape back into API auth.
          asset.pathname = "/";
          const response = await env.CONSOLE_ASSETS.fetch(new Request(asset, request));
          const headers = new Headers(response.headers);
          headers.set("Content-Type", "text/html; charset=UTF-8");
          headers.delete("Content-Disposition");
          return new Response(response.body, { status: response.status, headers });
        }
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
        if (request.method !== "GET" || !BROWSER_READS.test(path) || !browser.scopes.includes(scope as never) || request.headers.get("upgrade"))
          throw new ApiError(403, "This browser token does not grant this read", "FORBIDDEN");
      }
      let auth = browser ? null : await authenticateMoney(request, env)
        ?? (((env.TEST_MODE === "1" && !bearer?.startsWith("Bearer art_")) || await authorized(request, env.API_TOKEN)) ? await authenticate(request, env) : null);
      if (path === "/mcp") {
        if (!auth) return agentMcpSignIn(request, publicOrigins(env as unknown as NodeJS.ProcessEnv, url.origin).of(request.headers), "");
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
          /^client_[a-f0-9]{40}$/.test(idOrKey) &&
          (await authorized(request, await agentToken(env.API_TOKEN, idOrKey)))
        ) {
          entry =
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
        }
      }
      if (!auth && !entry && match?.[1] === "v1/agents" && match[3] === "/mcp")
        return agentMcpSignIn(request, env.AGENT_PUBLIC_URL || url.origin, match[2]);
      if (!auth && !entry)
        throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
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
        if (path === "/v1/inputs" && request.method === "GET") {
          const entries = await new Directory(env, auth.tenantId).list();
          const inputs = [];
          for (const entry of entries) {
            const response = await forward(request, env, entry.id, "/inputs");
            if (!response.ok) return response;
            inputs.push(...await response.json() as Array<{ id: string; createdAt: number }>);
          }
          return json(inputs.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, 100));
        }
        const media = await handleMediaRequest(request, env, auth);
        if (media) return media;
        const files = await handleFileRequest(request, env, auth);
        if (files) return files;
        const definition = await definitionRoutes(request, env, auth);
        if (definition) return definition;
        const provider = await providerRoutes(request, env, auth);
        if (provider) return provider;
        const run = await statelessRoutes(request, env, auth);
        if (run) return run;
        if (path === "/v1/models" && request.method === "GET")
          return json(
            modelCatalog(env, url.searchParams.get("provider") ?? undefined),
          );
        if (path === "/v1/agents") {
          const directory = new Directory(env, auth.tenantId);
          if (request.method === "GET")
            return json(
              (await directory.list())
                .filter((entry) => entry.config.type !== "run")
                .map(summary),
            );
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
                if (!upsert.reconfigured && !created.reconfigured) {
                  await journey.agentCreated({ tenant: auth.tenantId, via: auth.kind === 'console' ? 'console' : auth.kind === 'oauth' ? 'mcp' : 'api', ...(auth.kind === 'console' ? { browser: journey.browser(request) } : {}) });
                }
                ctx.waitUntil(journey.send());
              }
            }
            if (Object.hasOwn(raw, "spendLimit"))
              await setAgentSpendLimit(
                env, auth.tenantId, created.id, (raw as { spendLimit: unknown }).spendLimit,
              );
            const answer = { ...credentials(created, auth.kind === "oauth" ? undefined : await agentToken(env.API_TOKEN, created.id)), ...(upsert.reconfigured ? { reconfigured: upsert.reconfigured } : {}), ...await builtinWarnings(env, auth.tenantId, created.config) };
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
      if (!entry || entry.config.type === "run") throw new ApiError(404, "Unknown agent", "AGENT_NOT_FOUND");
      const tail = match[3] || "/";
      if (tail === "/configuration-target")
        throw new ApiError(404, "Not found", "NOT_FOUND");
      // Internal computer operations are reachable only through the service
      // binding. Public cleanup must use the account-scoped confirmation route.
      if (tail === "/__computer" && env.TEST_MODE !== "1")
        throw new ApiError(404, "Not found", "NOT_FOUND");
      const directory = new Directory(env, entry.tenantId);
      if (entry.deleted) {
        if ((auth || browser || ["/", "/credentials"].includes(tail)) && request.method === "GET")
          throw new ApiError(404, "Unknown agent", "AGENT_NOT_FOUND");
        if (auth && tail === "/" && request.method === "DELETE") {
          result(await directory.remove(entry.id));
          return json({ deleted: true });
        }
        throw new ApiError(410, "Agent is deleted", "AGENT_GONE");
      }
      if (entry.expiresAt && entry.expiresAt <= Date.now())
        throw new ApiError(410, "Agent expired", "AGENT_EXPIRED");
      if (!entry.initialized)
        throw new ApiError(
          503,
          "Agent initialization is pending; retry creation",
          "INITIALIZATION_PENDING",
        );
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
      if (tail === "/credentials" && request.method === "GET") {
        if (!auth) throw new ApiError(401, "Account key required", "UNAUTHORIZED");
        if (!entry.key) throw new ApiError(409, "AGENT_KEYLESS: this agent was made without a key, so its token is only what its create answered", "AGENT_KEYLESS");
        return json(
          credentials(entry, await agentToken(env.API_TOKEN, entry.id)),
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
        );
        if (!response.ok) return response;
        const stateResponse = await forward(
          new Request(request.url, { headers: request.headers }), env, entry.id, "/state",
        );
        if (!stateResponse.ok) return stateResponse;
        const state = await stateResponse.json() as { requests: { state: string }[]; cursor: number; running: boolean; spendLimit?: unknown };
        return json({
          ...summary(entry),
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
        if (auth) {
          const allowed = new Set(["model", "systemPrompt", "systemPromptAppend", "thinkingLevel", "maxOutputTokens", "temperature", "dataCollection", "language", "keyScope", "spendLimit", "bucket", "runLimits", "modelHeaders", "builtins", "decide", "delegate", "workflow", "mcpServers"]);
          const unknown = Object.keys(params).find(field => !allowed.has(field));
          if (unknown) throw new BadRequest(`Unsupported field: ${unknown}`);
        }
        if (requestId !== undefined && (typeof requestId !== "string" || !requestId.length))
          throw new BadRequest("requestId must be a nonempty string");
        const patched = configuration({ ...entry.config, ...params }, entry.config.model ?? env.MODEL).config;
        if (Object.hasOwn(params, "model") || Object.hasOwn(params, "keyScope")) {
          try {
            const modelError = await configurationModelError(env, entry.tenantId, patched);
            if (modelError) throw new Error(modelError);
          } catch (error) { throw new ApiError(400, (error as Error).message); }
        }
        return forward(new Request(request.url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: requestId ?? request.headers.get("Idempotency-Key") ?? crypto.randomUUID(), method: "configure", params }),
        }), env, entry.id, "/requests");
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
      const lifecycle = !browser
        ? await agentLifecycleRoutes(request, env, entry, tail, auth?.kind !== "oauth")
        : undefined;
      if (lifecycle) return lifecycle;
      if (tail === "/requests" && request.method === "POST") {
        const input = (await request.clone().json()) as { method?: string; params?: Record<string, unknown> };
        if (!auth && input.method === "configure") scopedConfiguration(input.params);
        if (input.method !== "configure" && input.params?.bucket !== undefined &&
          (!auth || !["prompt", "continue"].includes(input.method ?? "")))
          throw new HttpError(auth ? 400 : 403, auth
            ? "bucket is for a model run (prompt, continue)"
            : "Only the tenant can choose a run's bucket");
      }
      // Browser grants retain Node's read-only SSE policy. The internal agent
      // endpoint also negotiates transports, so strip the WebSocket offer here.
      if (browser && tail === "/events") {
        const headers = new Headers(request.headers);
        headers.set("accept", "text/event-stream");
        request = new Request(request, { headers });
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
      const response = tail === "/events"
        ? await eventRead(request, env, entry.tenantId, entry.id, request => forward(request, env, entry!.id, tail))
        : await forward(request, env, entry.id, tail);
      return browser ? browserResponse(response, browser, tail) : response;
    } catch (error) {
      const limited = admissionError(error);
      if (limited) return limited;
      if (error instanceof ApiError || error instanceof HttpError)
        return Response.json({ error: error.message, code: error.code, ...errorFields(error), ...("details" in error ? error.details : {}) }, { status: error.status, headers: { 'cache-control': 'no-store', ...errorHeaders(error) } });
      if (error instanceof BadRequest || error instanceof URIError)
        return json({ error: error.message, code: "INVALID_REQUEST" }, 400);
      failure(env, "http_failed", error);
      const status = errorStatus(error, 500);
      return Response.json({ error: "Backend operation failed", code: errorCode(error, status) },
        { status, headers: { 'cache-control': 'no-store', ...errorHeaders(error) } });
    }
    })()));
  },
  async queue(batch: MessageBatch<DeliveryMessage>, env: Env) {
    return withMoneyMetrics(env, async () => {
    await sendMoneyWebhooks(env);
    for (const message of batch.messages.filter(message => message.body.kind === "schedule")) {
      try { if (await deliverScheduleEmail(env, message.body.id)) message.ack(); else message.retry({ delaySeconds: 10 }); }
      catch { message.retry({ delaySeconds: 30 }); }
    }
    await consumeWebhooks({ ...batch, messages: batch.messages.filter(message => message.body.kind === "email") } as MessageBatch<DeliveryMessage>, env);
    for (const message of batch.messages) if (message.body.kind !== "email" && message.body.kind !== "schedule") message.ack();
    });
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    return withMoneyMetrics(env, async () => {
    try {
      await maintenance(env);
      await moneyMaintenance(env);
      await publishScheduleEmails(env);
      await sweepComputers(env);
      await sendJourney(env);
      metric(env, "maintenance", { MaintenanceRuns: 1 });
    } catch (error) { failure(env, "maintenance_failed", error); throw error; }
    });
  },
} satisfies ExportedHandler<Env, DeliveryMessage>;
export default worker;
